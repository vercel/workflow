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
import { MAX_BATCH_EVENTS } from '../constants.js';
import type { SuspensionSerializationBlocker } from '../suspension-handler.js';
import { unserializableStepInputPlaceholder } from '../unserializable-step.js';
import type { InBandWriter } from './in-band-writer.js';

/** A step this suspension created, and how it executes. */
export interface CreatedStep {
  correlationId: string;
  stepName: string;
  inline: boolean;
  input: SerializedData;
  /** The committed `step_created`. */
  event: Event;
  /**
   * The committed `step_started` of the step's first attempt, when it went
   * out in the same batch as `step_created` (an inline step on a World with
   * `createBatch`). The executor then writes no start of its own.
   */
  started?: StartedInBatch;
  /**
   * Why the World refused that batched `step_started` (a throttle, a
   * finished run), as the error a single start write would have thrown.
   * The executor acts on it as on its own start's refusal. Absent for a
   * refusal it would not act on; the executor then writes the start.
   */
  startRefusal?: Error;
}

/** A `step_started` an inline step's creation batch committed. */
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
 * Writes the `step_created` and `wait_created` events of one suspension
 * through the orchestrator's in-band writer.
 *
 * - Each `step_created` records the step's execution mode, fixed here for
 *   good: `inline: true` for the first `inlineSlots` new steps (the
 *   orchestrator runs them in this process), `inline: false` for the rest
 *   (they are enqueued once, right after this commit, and never run
 *   inline).
 * - Each `step_created` and `wait_created` records `creatorMessageId`, the
 *   queue message of this delivery: only a redelivery of it re-enqueues a
 *   background step or schedules a wait's timer.
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
 * The `step_created` and `wait_created` events of one suspension, prepared
 * (inputs serialized, execution modes decided) and not yet written.
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
  /**
   * The events the commit writes, in order: each step's `step_created`
   * (and, under `startInlineSteps`, its first `step_started` right behind
   * it), then the waits' `wait_created`. Steps whose input failed to
   * serialize are not among them.
   */
  events: readonly CreateEventRequest[];
  /** Writes the events. See {@link createStepsAndWaits}. */
  commit(): Promise<StepWaitCreationResult>;
  /**
   * Writes the events as {@link commit} does, and resolves `first` as soon
   * as the first batch committed: with the steps that batch created, which
   * include every inline step (they come first in {@link events}). `rest`
   * resolves with the steps the later batches created, once they committed.
   * For a plan with no waits and no step that failed to serialize.
   */
  commitInChunks(): {
    first: Promise<StepWaitCreationResult>;
    rest: Promise<StepWaitCreationResult>;
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
  /**
   * Write each inline step's first `step_started` in the same batch as its
   * `step_created`, saving the executor's own start write. Only taken when
   * the World has `createBatch`; otherwise the executor writes the start.
   * The orchestrator sets it when it runs the inline steps right after the
   * commit.
   */
  startInlineSteps?: boolean;
  requestId?: string;
  /** Called with each accepted write, to fold it into the loaded log. */
  onCommitted?: (result: {
    event?: Event;
    events?: Event[];
    hasMore?: boolean;
    reportIncomplete?: boolean;
  }) => void;
}

/**
 * Prepares one suspension's `step_created` and `wait_created` events without
 * writing them. Turbo mode starts inline step bodies from the plan while the
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
  const startInline =
    params.startInlineSteps === true && params.writer.supportsBatch;
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
    events.push({
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: entry.item.correlationId,
      eventData: {
        stepName: entry.item.stepName,
        workflowName: run.workflowName,
        input: entry.input,
        inline,
        creatorMessageId: params.creatorMessageId,
      },
    });
    if (inline && startInline) {
      // A plain append right behind the creation: the orchestrator runs the
      // body as soon as both commit.
      events.push({
        eventType: 'step_started',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: entry.item.correlationId,
        eventData: {
          stepName: entry.item.stepName,
          attempt: 1,
          startReason: 'first',
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
    events,
    commit: () =>
      commitPlan(params, prepared, events, createdSteps, {
        serializationBlockerCount,
        serializationBlockers,
      }),
    commitInChunks: () =>
      commitPlanInChunks(
        params,
        events,
        createdSteps,
        serializationBlockerCount
      ),
  };
}

function commitPlanInChunks(
  params: StepWaitCreationParams,
  events: CreateEventRequest[],
  createdSteps: Omit<CreatedStep, 'event'>[],
  serializationBlockerCount: number
): {
  first: Promise<StepWaitCreationResult>;
  rest: Promise<StepWaitCreationResult>;
} {
  const postSentAtMs = Date.now();
  const resultOf = (
    written: { committed: Event[]; refusedStarts: Map<string, Error> },
    steps: Omit<CreatedStep, 'event'>[]
  ): StepWaitCreationResult => ({
    ...stepResults(steps, written, postSentAtMs, Date.now()),
    failedStepCorrelationIds: new Set(),
    serializationBlockerCount,
    serializationBlockers: [],
  });
  let resolveFirst!: (result: StepWaitCreationResult) => void;
  const firstBatch = new Promise<StepWaitCreationResult>((resolve) => {
    resolveFirst = resolve;
  });
  const rest = writeAll(params, events, (written) =>
    resolveFirst(resultOf(written, createdSteps))
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
  return { first, rest };
}

/**
 * Each of `steps` whose `step_created` is among `written`, with its batched
 * `step_started` or that start's refusal.
 */
function stepResults(
  steps: Omit<CreatedStep, 'event'>[],
  written: { committed: Event[]; refusedStarts: Map<string, Error> },
  postSentAtMs: number,
  completedAtMs: number
): { createdSteps: CreatedStep[]; createdWaits: Event[] } {
  const stepEvents = new Map<string, Event>();
  const startEvents = new Map<string, Event>();
  const createdWaits: Event[] = [];
  for (const event of written.committed) {
    if (event.eventType === 'step_created' && event.correlationId) {
      stepEvents.set(event.correlationId, event);
    } else if (event.eventType === 'step_started' && event.correlationId) {
      startEvents.set(event.correlationId, event);
    } else if (event.eventType === 'wait_created') {
      createdWaits.push(event);
    }
  }
  return {
    createdSteps: steps.flatMap((step) => {
      const event = stepEvents.get(step.correlationId);
      if (!event) return [];
      // A start counts only behind its own creation: a batch item that
      // failed leaves the step created and not started, and the executor
      // then writes the start itself.
      const started = startEvents.get(step.correlationId);
      const startRefusal = written.refusedStarts.get(step.correlationId);
      return [
        {
          ...step,
          event,
          ...(started
            ? { started: { event: started, postSentAtMs, completedAtMs } }
            : {}),
          ...(startRefusal ? { startRefusal } : {}),
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
      reportIncomplete?: boolean;
    }) => void;
  },
  events: CreateEventRequest[],
  /** Called once the first batch committed, with what it committed. */
  onFirstBatch?: (written: {
    committed: Event[];
    refusedStarts: Map<string, Error>;
  }) => void
): Promise<{ committed: Event[]; refusedStarts: Map<string, Error> }> {
  const refusedStarts = new Map<string, Error>();
  if (events.length === 0) return { committed: [], refusedStarts };
  const { writer } = params;
  if (events.length > 1 && writer.supportsBatch) {
    const committed: Event[] = [];
    for (const chunk of batchChunks(events)) {
      const batch: BatchEventRequest[] = chunk.map((event) =>
        event.eventType === 'step_started'
          ? { event, computeInstanceId: COMPUTE_INSTANCE_ID }
          : { event }
      );
      const eventCount = params.eventCount();
      const batchResult = await writer.createBatch(batch, {
        ...(params.requestId ? { requestId: params.requestId } : {}),
        ...(eventCount !== undefined ? { eventCount } : {}),
      });
      const { results } = batchResult;
      let first = true;
      for (const result of results) {
        if (result.error !== undefined) continue;
        params.onCommitted?.({
          event: result.event,
          ...(first
            ? {
                events: batchResult.events,
                reportIncomplete: batchResult.reportIncomplete,
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
        if (event?.eventType === 'step_started') {
          // A batched inline start: the step is created and not started. Its
          // executor treats a throttle or a finished run as its own start's
          // refusal, and otherwise writes the start itself.
          const refusal =
            result.status === 429
              ? new ThrottleError(message)
              : result.status === 410
                ? new RunExpiredError(message)
                : undefined;
          if (refusal && event.correlationId) {
            refusedStarts.set(event.correlationId, refusal);
          }
          return;
        }
        // A transient refusal fails the delivery so the queue redelivers it,
        // the same way a single-path write of the same status would.
        if (result.status === 429) throw new ThrottleError(message);
        if (result.status >= 500) {
          throw new WorkflowWorldError(message, { status: result.status });
        }
      });
      if (onFirstBatch) {
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
    const result = await writer.create(event, {
      ...(params.requestId ? { requestId: params.requestId } : {}),
      ...(eventCount !== undefined ? { eventCount } : {}),
    });
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
 * Splits a suspension's creations into batches of at most
 * {@link MAX_BATCH_EVENTS}, keeping each step's `step_created` and the
 * `step_started` behind it in one batch. When they need more than one batch,
 * the inline steps' pairs (which come first) go in batches of their own: the
 * inline bodies start once those commit, and a smaller batch commits sooner.
 */
export function batchChunks(
  events: CreateEventRequest[]
): CreateEventRequest[][] {
  const chunks: CreateEventRequest[][] = [];
  let current: CreateEventRequest[] = [];
  const split = events.length > MAX_BATCH_EVENTS;
  let currentHasPairs = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const next = events[index + 1];
    const unit =
      event.eventType === 'step_created' &&
      next?.eventType === 'step_started' &&
      next.correlationId === event.correlationId
        ? [event, next]
        : [event];
    if (unit.length === 2) index++;
    const isPair = unit.length === 2;
    if (split && currentHasPairs && !isPair && current.length > 0) {
      chunks.push(current);
      current = [];
      currentHasPairs = false;
    }
    if (current.length + unit.length > MAX_BATCH_EVENTS) {
      chunks.push(current);
      current = [];
      currentHasPairs = false;
    }
    if (isPair) currentHasPairs = true;
    current.push(...unit);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
