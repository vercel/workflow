import type { Span } from '@opentelemetry/api';
import {
  EntityConflictError,
  FatalError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  AttributeValidationError,
  type CreateEventRequest,
  type SerializedData,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { importKey } from '../encryption.js';
import type {
  AttributeInvocationQueueItem,
  HookInvocationQueueItem,
  StepInvocationQueueItem,
  WaitInvocationQueueItem,
  WorkflowSuspension,
} from '../global.js';
import { runtimeLogger } from '../logger.js';
import { dehydrateStepArguments } from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getAbortStreamIdFromToken } from '../util.js';

export interface SuspensionHandlerParams {
  suspension: WorkflowSuspension;
  world: World;
  run: WorkflowRun;
  span?: Span;
  requestId?: string;
}

/**
 * Result of handling a suspension. Returns pending step items so the caller
 * can decide which to execute inline vs queue to background.
 */
export interface SuspensionHandlerResult {
  /** Pending step items with events created but NOT queued */
  pendingSteps: StepInvocationQueueItem[];
  /**
   * Correlation IDs for which this suspension call actually wrote the
   * step_created event (as opposed to catching EntityConflictError because
   * a concurrent handler wrote it first). Only the handler that wrote the
   * step_created event should queue / inline-execute the step — this
   * guarantees a single owner per step, even when multiple handlers race
   * into the same batch boundary.
   */
  createdStepCorrelationIds: Set<string>;
  /** Timeout from waits, if any */
  timeoutSeconds?: number;
  /** Whether a hook conflict was detected (should re-invoke immediately) */
  hasHookConflict: boolean;
  /** Whether native workflow attribute events were written for replay. */
  hasAttributeEvents: boolean;
}

/**
 * Handles a workflow suspension by processing all pending operations (hooks, steps, waits).
 * Creates events for all operations but does NOT queue step messages — returns the pending
 * steps so the caller can decide which to execute inline vs queue to background.
 *
 * Processing order:
 * 1. Hooks are processed first to prevent race conditions with webhook receivers
 * 2. Step events and wait events are created in parallel
 */
export async function handleSuspension({
  suspension,
  world,
  run,
  span,
  requestId,
}: SuspensionHandlerParams): Promise<SuspensionHandlerResult> {
  const runId = run.runId;
  // Separate queue items by type
  const stepItems = suspension.steps.filter(
    (item): item is StepInvocationQueueItem => item.type === 'step'
  );
  const allHookItems = suspension.steps.filter(
    (item): item is HookInvocationQueueItem => item.type === 'hook'
  );
  const waitItems = suspension.steps.filter(
    (item): item is WaitInvocationQueueItem => item.type === 'wait'
  );
  const attributeItems = suspension.steps.filter(
    (item): item is AttributeInvocationQueueItem => item.type === 'attribute'
  );

  // Split hooks by what actions they need
  const hooksNeedingCreation = allHookItems.filter(
    (item) => !item.hasCreatedEvent
  );
  const hooksNeedingDisposal = allHookItems.filter((item) => item.disposed);

  // Resolve encryption key for this run
  const rawKey = await world.getEncryptionKeyForRun?.(run);
  const encryptionKey = rawKey ? await importKey(rawKey) : undefined;

  // Build and process hook_created events (same as V1)
  const hookEvents: CreateEventRequest[] = await Promise.all(
    hooksNeedingCreation.map(async (queueItem) => {
      const hookMetadata: SerializedData | undefined =
        typeof queueItem.metadata === 'undefined'
          ? undefined
          : ((await dehydrateStepArguments(
              queueItem.metadata,
              runId,
              encryptionKey,
              suspension.globalThis
            )) as SerializedData);
      return {
        eventType: 'hook_created' as const,
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: queueItem.correlationId,
        eventData: {
          token: queueItem.token,
          metadata: hookMetadata,
          isWebhook: queueItem.isWebhook ?? false,
          ...(queueItem.isSystem && { isSystem: true }),
        },
      };
    })
  );

  // Process hooks first to prevent race conditions with webhook receivers.
  // All hook creations run in parallel.
  // Track any hook conflicts that occur — these are returned to the caller
  // so the V2 handler can re-invoke immediately.
  let hasHookConflict = false;

  if (hookEvents.length > 0) {
    await Promise.all(
      hookEvents.map(async (hookEvent) => {
        try {
          const result = await world.events.create(runId, hookEvent, {
            requestId,
          });
          // Check if the world returned a hook_conflict event instead of hook_created.
          // The hook_conflict event is stored in the event log and will be replayed
          // on the next workflow invocation, causing the hook's promise to reject.
          // Note: hook events always create an event (legacy runs throw, not return undefined)
          if (result.event!.eventType === 'hook_conflict') {
            hasHookConflict = true;
          }
        } catch (err) {
          if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
            runtimeLogger.info(
              'Workflow run already completed, skipping hook',
              {
                workflowRunId: runId,
                message: err.message,
              }
            );
          } else {
            throw err;
          }
        }
      })
    );
  }

  // Process hook disposals — these release hook tokens for reuse by other workflows.
  if (hooksNeedingDisposal.length > 0) {
    await Promise.all(
      hooksNeedingDisposal.map(async (queueItem) => {
        const hookDisposedEvent: CreateEventRequest = {
          eventType: 'hook_disposed' as const,
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: queueItem.correlationId,
          eventData: {
            token: queueItem.token,
          },
        };
        try {
          await world.events.create(runId, hookDisposedEvent, { requestId });
        } catch (err) {
          if (EntityConflictError.is(err)) {
            // Hook was already disposed by a concurrent invocation — safe to skip
            runtimeLogger.info(
              'Hook already disposed, skipping duplicate disposal',
              {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              }
            );
          } else if (RunExpiredError.is(err)) {
            runtimeLogger.info(
              'Workflow run already completed, skipping hook disposal',
              {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              }
            );
          } else if (HookNotFoundError.is(err)) {
            // Hook may have already been disposed or never created
            runtimeLogger.info('Hook not found for disposal, continuing', {
              workflowRunId: runId,
              correlationId: queueItem.correlationId,
              message: err.message,
            });
          } else {
            throw err;
          }
        }
      })
    );
  }

  // Process abort requests — resume the hook with abort payload and write stream packet
  const hooksNeedingAbort = allHookItems.filter(
    (item) => item.abortRequested && !item.disposed
  );

  if (hooksNeedingAbort.length > 0) {
    await Promise.all(
      hooksNeedingAbort.map(async (queueItem) => {
        try {
          // Dehydrate the abort payload for storage
          const abortPayload = await dehydrateStepArguments(
            { aborted: true, reason: queueItem.abortReason },
            runId,
            encryptionKey,
            suspension.globalThis
          );

          // Create hook_received event with abort payload
          await world.events.create(runId, {
            eventType: 'hook_received' as const,
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: queueItem.correlationId,
            eventData: {
              token: queueItem.token,
              payload: abortPayload,
            },
          });

          // Write stream cancellation packet for real-time step propagation.
          // Reuse the same dehydrated payload as the hook event so the reason
          // round-trips through `dehydrateStepArguments` / `hydrateStepArguments`
          // (handles DOMException, custom errors, encryption, etc.) instead of
          // bare JSON.stringify which loses type information and drops undefined.
          // streamName is set on the queue item at controller construction time
          // (see workflow/abort-controller.ts).
          try {
            const streamName = getAbortStreamIdFromToken(queueItem.token);
            await world.streams.write(
              runId,
              streamName,
              abortPayload as Uint8Array
            );
            await world.streams.close(runId, streamName);
          } catch {
            // Best-effort stream write — hook event provides the durable fallback
            runtimeLogger.debug(
              'Failed to write abort stream packet, hook event will provide fallback',
              {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
              }
            );
          }
        } catch (err) {
          if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
            runtimeLogger.info(
              'Workflow run already completed, skipping abort',
              {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              }
            );
          } else {
            throw err;
          }
        }
      })
    );
  }

  // Create step events for steps that don't have them yet.
  // Unlike V1, we do NOT queue step messages from here — the caller
  // decides which steps to execute inline vs. queue to background.
  // Wait events are also created in parallel below.
  const stepsNeedingCreation = new Set(
    stepItems
      .filter((queueItem) => !queueItem.hasCreatedEvent)
      .map((queueItem) => queueItem.correlationId)
  );

  // Correlation IDs for which THIS suspension call actually wrote the
  // step_created event. Populated by the ops below after a successful
  // events.create — used by the caller to claim ownership and avoid
  // racing with concurrent handlers on step execution.
  const createdStepCorrelationIds = new Set<string>();

  const ops: Promise<void>[] = [];

  // Steps: create step_created events (no queuing — V2 returns pending steps to caller)
  for (const queueItem of stepItems) {
    if (stepsNeedingCreation.has(queueItem.correlationId)) {
      ops.push(
        (async () => {
          const dehydratedInput = await dehydrateStepArguments(
            {
              args: queueItem.args,
              closureVars: queueItem.closureVars,
              thisVal: queueItem.thisVal,
            },
            runId,
            encryptionKey,
            suspension.globalThis
          );
          const stepEvent: CreateEventRequest = {
            eventType: 'step_created' as const,
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: queueItem.correlationId,
            eventData: {
              stepName: queueItem.stepName,
              input: dehydratedInput as SerializedData,
            },
          };
          try {
            await world.events.create(runId, stepEvent, { requestId });
            createdStepCorrelationIds.add(queueItem.correlationId);
          } catch (err) {
            if (EntityConflictError.is(err)) {
              runtimeLogger.info('Step already exists, continuing', {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              });
            } else {
              throw err;
            }
          }
        })()
      );
    }
  }

  // Create wait events (same as V1)
  for (const queueItem of waitItems) {
    if (!queueItem.hasCreatedEvent) {
      ops.push(
        (async () => {
          const waitEvent: CreateEventRequest = {
            eventType: 'wait_created' as const,
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: queueItem.correlationId,
            eventData: {
              resumeAt: queueItem.resumeAt,
            },
          };
          try {
            await world.events.create(runId, waitEvent, { requestId });
          } catch (err) {
            if (EntityConflictError.is(err)) {
              runtimeLogger.info('Wait already exists, continuing', {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              });
            } else {
              throw err;
            }
          }
        })()
      );
    }
  }

  for (const queueItem of attributeItems) {
    ops.push(
      (async () => {
        try {
          await world.events.create(
            runId,
            {
              eventType: 'attr_set',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: queueItem.correlationId,
              eventData: {
                changes: queueItem.changes,
                writer: { type: 'workflow' },
                ...(queueItem.allowReservedAttributes
                  ? { allowReservedAttributes: true }
                  : {}),
              },
            },
            { requestId }
          );
        } catch (err) {
          if (EntityConflictError.is(err)) {
            runtimeLogger.info(
              'Workflow attribute event already exists, continuing',
              {
                workflowRunId: runId,
                correlationId: queueItem.correlationId,
                message: err.message,
              }
            );
          } else if (isAttributeValidationFailure(err)) {
            // Deterministic validation rejection from the World — e.g. the
            // cumulative per-run attribute cap, which only the World can
            // check against the run's existing attributes. Redelivering the
            // orchestrator message replays the workflow into the exact same
            // write and the exact same rejection, so retrying can never
            // succeed. Surface it as a FatalError so the caller fails the
            // run with a clear error instead of wedging it in redelivery.
            const fatal = new FatalError(
              `experimental_setAttributes failed World validation: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
            fatal.cause = err;
            throw fatal;
          } else {
            throw err;
          }
        }
      })()
    );
  }

  // Await the step_created / wait_created event creates before returning.
  // The caller (workflowEntrypoint) only enqueues the step-dispatch queue
  // messages AFTER handleSuspension resolves, and the queue handler acks
  // the orchestrator message only after the caller resolves. So the step_created
  // events must be durable here, and the dispatch sends must complete in the caller,
  // all before ack. If the process crashes before this resolves, the orchestrator
  // message is not acked and VQS redelivers, re-creates the (idempotent)
  // step_created and re-dispatches, and recovers the run instead of orphaning it.
  await Promise.all(ops);

  // Calculate minimum timeout from waits
  const now = Date.now();
  const minTimeoutSeconds = waitItems.reduce<number | null>(
    (min, queueItem) => {
      const resumeAtMs = queueItem.resumeAt.getTime();
      const delayMs = Math.max(1000, resumeAtMs - now);
      const timeoutSeconds = Math.ceil(delayMs / 1000);
      if (min === null) return timeoutSeconds;
      return Math.min(min, timeoutSeconds);
    },
    null
  );

  span?.setAttributes({
    ...Attribute.WorkflowRunStatus('workflow_suspended'),
    ...Attribute.WorkflowStepsCreated(stepItems.length),
    ...Attribute.WorkflowHooksCreated(hooksNeedingCreation.length),
    ...Attribute.WorkflowWaitsCreated(waitItems.length),
  });

  return {
    pendingSteps: stepItems,
    createdStepCorrelationIds,
    timeoutSeconds: hasHookConflict ? 0 : (minTimeoutSeconds ?? undefined),
    hasHookConflict,
    hasAttributeEvents: attributeItems.length > 0,
  };
}

/**
 * Whether an `events.create` rejection is a deterministic attribute
 * validation failure rather than a transient/storage error. Local Worlds
 * (world-local, world-postgres) throw `AttributeValidationError` directly;
 * remote Worlds surface the equivalent server-side rejection as a
 * `WorkflowWorldError` with HTTP status 400. The name check covers
 * `AttributeValidationError` instances from a different copy of
 * `@workflow/world` than the one this package resolved.
 */
function isAttributeValidationFailure(err: unknown): boolean {
  if (err instanceof AttributeValidationError) return true;
  if (err instanceof Error && err.name === 'AttributeValidationError') {
    return true;
  }
  return WorkflowWorldError.is(err) && err.status === 400;
}
