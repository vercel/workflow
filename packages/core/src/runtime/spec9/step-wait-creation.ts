import {
  RunExpiredError,
  SerializationError,
  ThrottleError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type BatchEventRequest,
  type CreateEventRequest,
  type Event,
  type SerializedData,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import type {
  StepInvocationQueueItem,
  WaitInvocationQueueItem,
  WorkflowSuspension,
} from '../../global.js';
import { runtimeLogger } from '../../logger.js';
import type { PayloadKey } from '../../serialization/encryption.js';
import {
  GUEST_CODE_EXECUTION_SAMPLE_LIMIT,
  type GuestCodeStats,
} from '../../serialization/hardened.js';
import {
  dehydrateStepArguments,
  dehydrateStepError,
} from '../../serialization.js';
import { COMPUTE_INSTANCE_ID } from '../compute-instance.js';
import {
  CREATION_EVENT_META_ALLOWANCE_BYTES,
  MAX_BATCH_EVENTS,
  MAX_IN_BAND_CREATION_BATCH_BYTES,
  MAX_IN_BAND_CREATION_BATCH_EVENTS,
} from '../constants.js';
import type { SuspensionSerializationBlocker } from '../delivery.js';
import { unserializableStepInputPlaceholder } from '../unserializable-step.js';
import type { InBandWriter } from './in-band-writer.js';

/** A step this suspension created, and how it executes. */
export interface CreatedStep {
  correlationId: string;
  stepName: string;
  inline: boolean;
  input: SerializedData;
  /**
   * The committed creation: a background step's `step_created`, or an
   * inline step's first `step_started`. Absent only beside
   * {@link startRefusal}.
   */
  event?: Event;
  /**
   * An inline step's committed first `step_started`, which is also its
   * creation. The executor then writes no start of its own.
   */
  started?: StartedInBatch;
  /**
   * Why the World refused an inline step's creation-bearing `step_started`
   * (a throttle, a finished run), as the error a single start write would
   * have thrown. The step is not created; the executor acts on the refusal
   * as on its own start's (a throttle defers the run by the World's backoff,
   * and the next delivery creates the step again).
   */
  startRefusal?: Error;
}

/** The `step_started` that created an inline step. */
export interface StartedInBatch {
  event: Event;
  /** `Date.now()` right before the batch was sent. */
  postSentAtMs: number;
  /** `Date.now()` once the batch returned. */
  completedAtMs: number;
}

export interface StepWaitCreationResult {
  createdSteps: CreatedStep[];
  /** Steps finalized as failed because their arguments did not serialize. */
  failedStepCorrelationIds: Set<string>;
  /** The committed `wait_created` events. */
  createdWaits: Event[];
  serializationBlockerCount: number;
  serializationBlockers: SuspensionSerializationBlocker[];
}

/**
 * Writes the step and wait creations of one suspension through the
 * orchestrator's in-band writer.
 *
 * - Each step's creation records its execution mode, fixed here for good.
 *   The first `inlineSlots` new steps are inline (the orchestrator runs them
 *   in this process): each is created by its first attempt's `step_started`
 *   alone, carrying what a `step_created` carries plus `inline: true`. The
 *   rest are background steps: a `step_created` with `inline: false`, and
 *   they are enqueued once, right after this commit, and never run inline.
 * - Each background step's `step_created` and each `wait_created` records
 *   `creatorMessageId`, the queue message of this delivery: only a
 *   redelivery of it re-enqueues a background step or schedules a wait's
 *   timer. An inline step's creating start records none.
 * - The events go out as one `createBatch` when the World has one, else one
 *   at a time. In-band writes are serialized, so a parallel fan-out of
 *   single writes would be refused by the fence.
 * - A step whose arguments fail to serialize is finalized as `step_created`
 *   (placeholder input) plus `step_failed`, so the workflow observes the
 *   error on the next replay.
 */
export async function createStepsAndWaits(
  params: StepWaitCreationParams
): Promise<StepWaitCreationResult> {
  return (await planStepsAndWaits(params)).commit();
}

/**
 * The step and wait creations of one suspension, prepared (inputs
 * serialized, execution modes decided) and not yet written.
 */
export interface StepWaitCreationPlan {
  /** The steps the commit creates, with their execution mode. */
  steps: Omit<CreatedStep, 'event'>[];
  /** How many waits the commit creates. */
  waitCount: number;
  /** How many steps failed to serialize; the commit finalizes them. */
  failedCount: number;
  /** Guest-code executions while serializing step inputs. */
  serializationBlockerCount: number;
  /** A sample of those executions, for diagnostics. */
  serializationBlockers: SuspensionSerializationBlocker[];
  /**
   * The events the commit writes, in order: each step's creation (an
   * inline step's `step_started`, a background step's `step_created`), then
   * the waits' `wait_created`. Steps whose input failed to serialize are not
   * among them.
   */
  events: readonly CreateEventRequest[];
  /** Writes the events. See {@link createStepsAndWaits}. */
  commit(): Promise<StepWaitCreationResult>;
  /**
   * Writes the events as {@link commit} does, and resolves `first` once
   * the first batch and every inline creation committed (inline steps come
   * first in {@link events}), with the steps those batches created. `rest`
   * resolves with the steps the later batches created, once they committed.
   * `queued` resolves once the last batch is queued on the writer (or the
   * commit stopped before it): a write queued after that goes out behind
   * every batch. For a plan with no waits and no step that failed to
   * serialize.
   *
   * `onLaterBatch` is called once per batch after the first, as soon as
   * that batch committed, with the steps it created. A batch that failed
   * is not reported; `rest` rejects with its error.
   */
  commitInChunks(onLaterBatch?: (result: StepWaitCreationResult) => void): {
    first: Promise<StepWaitCreationResult>;
    rest: Promise<StepWaitCreationResult>;
    queued: Promise<void>;
  };
}

export interface StepWaitCreationParams {
  suspension: WorkflowSuspension;
  run: WorkflowRun;
  writer: InBandWriter;
  eventCount: () => number | undefined;
  encryptionKey: PayloadKey | undefined;
  compression: boolean;
  creatorMessageId: string;
  inlineSlots: number;
  requestId?: string;
  /** Called with each accepted write, to fold it into the loaded log. */
  onCommitted?: (result: {
    event?: Event;
    events?: Event[];
    hasMore?: boolean;
  }) => void;
}

/**
 * Prepares one suspension's step and wait creations without writing them. Turbo mode starts inline step bodies from the plan while the
 * commit is in flight; everyone else commits at once
 * ({@link createStepsAndWaits}).
 */
export async function planStepsAndWaits(
  params: StepWaitCreationParams
): Promise<StepWaitCreationPlan> {
  const { suspension, run, encryptionKey, compression } = params;
  const runId = run.runId;
  const stepItems = suspension.items.filter(
    (item): item is StepInvocationQueueItem =>
      item.type === 'step' && !item.hasCreatedEvent
  );
  const waitItems = suspension.items.filter(
    (item): item is WaitInvocationQueueItem =>
      item.type === 'wait' && !item.hasCreatedEvent
  );

  let serializationBlockerCount = 0;
  const serializationBlockers: SuspensionSerializationBlocker[] = [];

  type Prepared =
    | { item: StepInvocationQueueItem; input: SerializedData }
    | { item: StepInvocationQueueItem; error: SerializationError };
  const prepared: Prepared[] = await Promise.all(
    stepItems.map(async (item): Promise<Prepared> => {
      const stats: GuestCodeStats = { executions: [] };
      try {
        const input = (await dehydrateStepArguments(
          {
            args: item.args,
            closureVars: item.closureVars,
            thisVal: item.thisVal,
          },
          runId,
          encryptionKey,
          suspension.globalThis,
          false,
          compression,
          stats
        )) as SerializedData;
        return { item, input };
      } catch (error) {
        if (!SerializationError.is(error)) throw error;
        return { item, error };
      } finally {
        serializationBlockerCount +=
          stats.totalExecutions ?? stats.executions.length;
        serializationBlockers.push(
          ...stats.executions
            .slice(
              0,
              GUEST_CODE_EXECUTION_SAMPLE_LIMIT - serializationBlockers.length
            )
            .map((execution) => ({
              source: 'step_input' as const,
              correlationId: item.correlationId,
              ...execution,
            }))
        );
      }
    })
  );

  const events: CreateEventRequest[] = [];
  const createdSteps: Omit<CreatedStep, 'event'>[] = [];
  let inlineLeft = params.inlineSlots;
  for (const entry of prepared) {
    if ('error' in entry) continue;
    const inline = inlineLeft > 0;
    if (inline) inlineLeft--;
    createdSteps.push({
      correlationId: entry.item.correlationId,
      stepName: entry.item.stepName,
      inline,
      input: entry.input,
    });
    if (inline) {
      // Created and started by one plain append: the orchestrator runs the
      // body as soon as it commits.
      events.push({
        eventType: 'step_started',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: entry.item.correlationId,
        eventData: {
          stepName: entry.item.stepName,
          workflowName: run.workflowName,
          input: entry.input,
          inline: true,
          attempt: 1,
        },
      });
    } else {
      events.push({
        eventType: 'step_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: entry.item.correlationId,
        eventData: {
          stepName: entry.item.stepName,
          workflowName: run.workflowName,
          input: entry.input,
          inline: false,
          creatorMessageId: params.creatorMessageId,
        },
      });
    }
  }
  for (const item of waitItems) {
    events.push({
      eventType: 'wait_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: item.correlationId,
      eventData: {
        resumeAt: item.resumeAt,
        creatorMessageId: params.creatorMessageId,
      },
    });
  }

  return {
    steps: createdSteps,
    waitCount: waitItems.length,
    failedCount: prepared.length - createdSteps.length,
    serializationBlockerCount,
    serializationBlockers,
    events,
    commit: () =>
      commitPlan(params, prepared, events, createdSteps, {
        serializationBlockerCount,
        serializationBlockers,
      }),
    commitInChunks: (onLaterBatch) =>
      commitPlanInChunks(
        params,
        events,
        createdSteps,
        {
          serializationBlockerCount,
          serializationBlockers,
        },
        onLaterBatch
      ),
  };
}

function commitPlanInChunks(
  params: StepWaitCreationParams,
  events: CreateEventRequest[],
  createdSteps: Omit<CreatedStep, 'event'>[],
  stats: {
    serializationBlockerCount: number;
    serializationBlockers: SuspensionSerializationBlocker[];
  },
  onLaterBatch?: (result: StepWaitCreationResult) => void
): {
  first: Promise<StepWaitCreationResult>;
  rest: Promise<StepWaitCreationResult>;
  queued: Promise<void>;
} {
  const postSentAtMs = Date.now();
  const resultOf = (
    written: Written,
    steps: Omit<CreatedStep, 'event'>[]
  ): StepWaitCreationResult => ({
    ...stepResults(steps, written, postSentAtMs, Date.now()),
    failedStepCorrelationIds: new Set(),
    ...stats,
  });
  let resolveFirst!: (result: StepWaitCreationResult) => void;
  const firstBatch = new Promise<StepWaitCreationResult>((resolve) => {
    resolveFirst = resolve;
  });
  let resolveQueued!: () => void;
  const queued = new Promise<void>((resolve) => {
    resolveQueued = resolve;
  });
  const rest = writeAll(
    params,
    events,
    (written) => resolveFirst(resultOf(written, createdSteps)),
    resolveQueued,
    onLaterBatch && ((written) => onLaterBatch(resultOf(written, createdSteps)))
  ).then(async (written) => {
    // Without a batch the writes went out one at a time: all of them are
    // the first.
    resolveFirst(resultOf(written, createdSteps));
    const reported = new Set(
      (await firstBatch).createdSteps.map((step) => step.correlationId)
    );
    return resultOf(
      written,
      createdSteps.filter((step) => !reported.has(step.correlationId))
    );
  });
  // A first batch that fails rejects both.
  const first = Promise.race([firstBatch, rest.then(() => firstBatch)]);
  first.catch(() => {});
  rest.catch(() => {});
  // A commit that stopped early (a failed batch) queues nothing more.
  void rest.then(resolveQueued, resolveQueued);
  return { first, rest, queued };
}

/** What a commit wrote, and the inline creations the World refused. */
interface Written {
  committed: Event[];
  refusedStarts: Map<string, Error>;
}

/**
 * Each of `steps` whose creation is among `written`: a background step's
 * `step_created`, or an inline step's first `step_started`, which is also
 * its start. An inline step whose creation-bearing start was refused for a
 * throttle or a finished run is included with that refusal.
 */
function stepResults(
  steps: Omit<CreatedStep, 'event'>[],
  written: Written,
  postSentAtMs: number,
  completedAtMs: number
): { createdSteps: CreatedStep[]; createdWaits: Event[] } {
  const stepEvents = new Map<string, Event>();
  const createdWaits: Event[] = [];
  for (const event of written.committed) {
    if (
      (event.eventType === 'step_created' ||
        event.eventType === 'step_started') &&
      event.correlationId
    ) {
      stepEvents.set(event.correlationId, event);
    } else if (event.eventType === 'wait_created') {
      createdWaits.push(event);
    }
  }
  return {
    createdSteps: steps.flatMap((step): CreatedStep[] => {
      const event = stepEvents.get(step.correlationId);
      if (!event) {
        const startRefusal = written.refusedStarts.get(step.correlationId);
        return startRefusal ? [{ ...step, startRefusal }] : [];
      }
      return [
        {
          ...step,
          event,
          ...(event.eventType === 'step_started'
            ? { started: { event, postSentAtMs, completedAtMs } }
            : {}),
        },
      ];
    }),
    createdWaits,
  };
}

async function commitPlan(
  params: StepWaitCreationParams,
  prepared: (
    | { item: StepInvocationQueueItem; input: SerializedData }
    | { item: StepInvocationQueueItem; error: SerializationError }
  )[],
  events: CreateEventRequest[],
  createdSteps: Omit<CreatedStep, 'event'>[],
  stats: {
    serializationBlockerCount: number;
    serializationBlockers: SuspensionSerializationBlocker[];
  }
): Promise<StepWaitCreationResult> {
  const failedStepCorrelationIds = new Set<string>();
  const postSentAtMs = Date.now();
  const written = await writeAll(params, events);
  const completedAtMs = Date.now();

  for (const entry of prepared) {
    if (!('error' in entry)) continue;
    await finalizeUnserializableStep(params, entry.item, entry.error);
    failedStepCorrelationIds.add(entry.item.correlationId);
  }

  return {
    ...stepResults(createdSteps, written, postSentAtMs, completedAtMs),
    failedStepCorrelationIds,
    serializationBlockerCount: stats.serializationBlockerCount,
    serializationBlockers: stats.serializationBlockers,
  };
}

async function writeAll(
  params: {
    writer: InBandWriter;
    eventCount: () => number | undefined;
    requestId?: string;
    run: WorkflowRun;
    onCommitted?: (result: {
      event?: Event;
      events?: Event[];
      hasMore?: boolean;
    }) => void;
  },
  events: CreateEventRequest[],
  /** Called after the first batch and all inline creations committed. */
  onFirstBatch?: (written: Written) => void,
  /** Called right after the last batch is queued on the writer. */
  onLastQueued?: () => void,
  /**
   * Called with what each batch after the one that called `onFirstBatch`
   * committed, once it committed. A batch that throws is not reported.
   */
  onLaterBatch?: (written: Written) => void
): Promise<Written> {
  const refusedStarts = new Map<string, Error>();
  if (events.length === 0) return { committed: [], refusedStarts };
  const { writer } = params;
  if (events.length > 1 && writer.supportsBatch) {
    const committed: Event[] = [];
    let inlineRemaining = events.filter(
      (event) => event.eventType === 'step_started'
    ).length;
    const chunks = batchChunks(events);
    for (const [index, chunk] of chunks.entries()) {
      const batch: BatchEventRequest[] = chunk.map((event) =>
        event.eventType === 'step_started'
          ? { event, computeInstanceId: COMPUTE_INSTANCE_ID }
          : { event }
      );
      const eventCount = params.eventCount();
      const sending = writer.createBatch(batch, {
        ...(params.requestId ? { requestId: params.requestId } : {}),
        ...(eventCount !== undefined ? { eventCount } : {}),
      });
      if (index === chunks.length - 1) onLastQueued?.();
      const batchResult = await sending;
      const { results } = batchResult;
      const reportsLater = onFirstBatch === undefined;
      const committedBefore = committed.length;
      let first = true;
      for (const result of results) {
        if (result.error !== undefined) continue;
        params.onCommitted?.({
          event: result.event,
          ...(first
            ? {
                events: batchResult.events,
                hasMore: batchResult.hasMore,
              }
            : {}),
        });
        first = false;
      }
      results.forEach((result, index) => {
        if (result.error === undefined) {
          committed.push(result.event);
          return;
        }
        // A batch on a spec >= 9 run is not atomic. A failed item left a
        // hole the World seals; the next replay re-derives the event and the
        // next suspension writes it again.
        runtimeLogger.warn('Suspension batch item was not committed', {
          workflowRunId: params.run.runId,
          eventType: chunk[index]?.eventType,
          correlationId: (chunk[index] as { correlationId?: string })
            ?.correlationId,
          status: result.status,
          error: result.error,
        });
        const message = `Suspension batch item failed with ${result.status}: ${result.message}`;
        const event = chunk[index];
        if (
          event?.eventType === 'step_started' &&
          event.correlationId &&
          (result.status === 429 || result.status === 410)
        ) {
          // An inline step's creation-bearing start: the step is not
          // created. Its executor treats a throttle or a finished run as its
          // own start's refusal.
          refusedStarts.set(
            event.correlationId,
            result.status === 429
              ? new ThrottleError(message)
              : new RunExpiredError(message)
          );
          return;
        }
        // A transient refusal fails the delivery so the queue redelivers it,
        // the same way a single-path write of the same status would.
        if (result.status === 429) throw new ThrottleError(message);
        if (result.status >= 500) {
          throw new WorkflowWorldError(message, { status: result.status });
        }
      });
      inlineRemaining -= chunk.filter(
        (event) => event.eventType === 'step_started'
      ).length;
      if (reportsLater) {
        onLaterBatch?.({
          committed: committed.slice(committedBefore),
          refusedStarts: new Map(),
        });
      } else if (onFirstBatch && inlineRemaining === 0) {
        onFirstBatch({
          committed: [...committed],
          refusedStarts: new Map(refusedStarts),
        });
        onFirstBatch = undefined;
      }
    }
    return { committed, refusedStarts };
  }
  const committed: Event[] = [];
  for (const event of events) {
    const eventCount = params.eventCount();
    let result: Awaited<ReturnType<InBandWriter['create']>>;
    try {
      result = await writer.create(event, {
        ...(event.eventType === 'step_started'
          ? { computeInstanceId: COMPUTE_INSTANCE_ID }
          : {}),
        ...(params.requestId ? { requestId: params.requestId } : {}),
        ...(eventCount !== undefined ? { eventCount } : {}),
      });
    } catch (error) {
      // As in a batch: a refused creation-bearing start is the step's
      // start refusal, and the writes behind it still go out.
      if (
        event.eventType === 'step_started' &&
        event.correlationId &&
        (ThrottleError.is(error) || RunExpiredError.is(error))
      ) {
        refusedStarts.set(event.correlationId, error as Error);
        continue;
      }
      throw error;
    }
    params.onCommitted?.(result);
    if (result.event) committed.push(result.event);
  }
  return { committed, refusedStarts };
}

async function finalizeUnserializableStep(
  params: {
    run: WorkflowRun;
    writer: InBandWriter;
    encryptionKey: PayloadKey | undefined;
    compression: boolean;
    creatorMessageId: string;
    suspension: WorkflowSuspension;
    requestId?: string;
  },
  item: StepInvocationQueueItem,
  error: SerializationError
): Promise<void> {
  const { run, writer, encryptionKey, compression, suspension } = params;
  runtimeLogger.warn(
    'Step arguments failed to serialize; failing the step so the workflow can observe the error',
    {
      workflowRunId: run.runId,
      correlationId: item.correlationId,
      stepName: item.stepName,
      error: error.message,
    }
  );
  const placeholderInput = (await dehydrateStepArguments(
    unserializableStepInputPlaceholder(),
    run.runId,
    encryptionKey,
    suspension.globalThis,
    false,
    compression
  )) as SerializedData;
  await writer.create({
    eventType: 'step_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: item.correlationId,
    eventData: {
      stepName: item.stepName,
      workflowName: run.workflowName,
      input: placeholderInput,
      inline: true,
      creatorMessageId: params.creatorMessageId,
    },
  });
  await writer.create({
    eventType: 'step_failed',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: item.correlationId,
    eventData: {
      stepName: item.stepName,
      attempt: 1,
      error: await dehydrateStepError(
        error,
        run.runId,
        encryptionKey,
        [],
        suspension.globalThis,
        compression
      ),
    },
  });
}

/**
 * Splits a suspension's creations into the batches it writes, one after
 * another, in order: each batch holds up to
 * {@link MAX_IN_BAND_CREATION_BATCH_EVENTS} creations and stays within
 * {@link MAX_IN_BAND_CREATION_BATCH_BYTES} (see {@link creationBatchBytes});
 * a single event over the byte budget still goes out, alone. A suspension of
 * at most {@link MAX_BATCH_EVENTS} creations is therefore one batch unless
 * its payloads overflow the byte budget.
 *
 * The inline steps' creation-bearing starts come first and share the first
 * batch with the background creations behind them. An in-band writer sends
 * one batch at a time, so a batch of their own would put one more round trip
 * in front of every background creation, and of the last branch's start. The
 * trade: the inline bodies start once the larger first batch commits rather
 * than a batch of only their starts. Each step's creation is a single event,
 * so no step's events straddle two batches.
 */
export function batchChunks(
  events: CreateEventRequest[]
): CreateEventRequest[][] {
  const chunks: CreateEventRequest[][] = [];
  let current: CreateEventRequest[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const bytes = creationBatchBytes(event);
    if (
      current.length > 0 &&
      (current.length + 1 > MAX_IN_BAND_CREATION_BATCH_EVENTS ||
        currentBytes + bytes > MAX_IN_BAND_CREATION_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * What one creation counts against {@link MAX_IN_BAND_CREATION_BATCH_BYTES}:
 * the binary payloads on its `eventData` (a step's serialized input) plus
 * {@link CREATION_EVENT_META_ALLOWANCE_BYTES} for the rest of the event.
 */
export function creationBatchBytes(event: CreateEventRequest): number {
  let bytes = CREATION_EVENT_META_ALLOWANCE_BYTES;
  const data = (event as { eventData?: Record<string, unknown> }).eventData;
  if (data) {
    for (const value of Object.values(data)) {
      if (ArrayBuffer.isView(value)) bytes += value.byteLength;
    }
  }
  return bytes;
}
