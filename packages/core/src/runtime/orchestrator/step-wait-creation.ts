import {
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
  /** Writes the events. See {@link createStepsAndWaits}. */
  commit(): Promise<StepWaitCreationResult>;
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
    commit: () =>
      commitPlan(params, prepared, events, createdSteps, {
        serializationBlockerCount,
        serializationBlockers,
      }),
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
  const committed = await writeAll(params, events);
  const stepEvents = new Map<string, Event>();
  const createdWaits: Event[] = [];
  for (const event of committed) {
    if (event.eventType === 'step_created' && event.correlationId) {
      stepEvents.set(event.correlationId, event);
    } else if (event.eventType === 'wait_created') {
      createdWaits.push(event);
    }
  }

  for (const entry of prepared) {
    if (!('error' in entry)) continue;
    await finalizeUnserializableStep(params, entry.item, entry.error);
    failedStepCorrelationIds.add(entry.item.correlationId);
  }

  return {
    createdSteps: createdSteps.flatMap((step) => {
      const event = stepEvents.get(step.correlationId);
      return event ? [{ ...step, event }] : [];
    }),
    failedStepCorrelationIds,
    createdWaits,
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
  events: CreateEventRequest[]
): Promise<Event[]> {
  if (events.length === 0) return [];
  const { writer } = params;
  if (events.length > 1 && writer.supportsBatch) {
    const batch: BatchEventRequest[] = events.map((event) => ({ event }));
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
    const committed: Event[] = [];
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
        eventType: events[index]?.eventType,
        correlationId: (events[index] as { correlationId?: string })
          ?.correlationId,
        status: result.status,
        error: result.error,
      });
      // A transient refusal fails the delivery so the queue redelivers it,
      // the same way a single-path write of the same status would.
      const message = `Suspension batch item failed with ${result.status}: ${result.message}`;
      if (result.status === 429) throw new ThrottleError(message);
      if (result.status >= 500) {
        throw new WorkflowWorldError(message, { status: result.status });
      }
    });
    return committed;
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
  return committed;
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
