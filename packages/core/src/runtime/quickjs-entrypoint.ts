/**
 * QuickJS runtime integration with the Workflow runtime.
 *
 * Entry point for running a workflow invocation using the QuickJS WASM
 * runtime instead of the default `node:vm` event-replay runtime.
 *
 * Unlike the (removed) snapshot runtime, this replays the FULL event log on
 * every invocation — no snapshot save/restore, no `world.snapshots.*`. Each
 * call:
 *   1. Loads the complete event log for the run.
 *   2. Runs the workflow in a fresh QuickJS VM (replaying all events).
 *   3. On completion: writes `run_completed`.
 *   4. On suspension: writes `step_created` / `hook_created` / `wait_created`
 *      events for new pending operations and queues steps; schedules wait
 *      timeouts.
 *   5. On failure: writes `run_failed`.
 *
 * Steps are queued through the same combined workflow queue as the node:vm
 * runtime (messages carrying a `stepId` are dispatched to `executeStep` in
 * runtime.ts), so step execution is shared between the two runtimes.
 */

import {
  EntityConflictError,
  RunExpiredError,
  WorkflowNotRegisteredError,
} from '@workflow/errors';
import { getPort } from '@workflow/utils/get-port';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type RunInput,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { classifyRunError } from '../classify-error.js';
import { importKey } from '../encryption.js';
import { runtimeLogger } from '../logger.js';
import { encrypt as encryptSerializedData } from '../serialization/encryption.js';
import {
  dehydrateRunError,
  hydrateRunError,
  maybeEncrypt,
} from '../serialization.js';
import { remapErrorStack, stripInlineSourceMap } from '../source-map.js';
import { serializeTraceCarrier } from '../telemetry.js';
import {
  getWorkflowQueueName,
  loadWorkflowRunEvents,
  queueMessage,
} from './helpers.js';
import {
  type PendingHook,
  type PendingStep,
  type PendingWait,
  runQuickJSWorkflow,
} from './quickjs-runtime.js';
import { getWorld } from './world.js';

/**
 * Run a single workflow invocation using the QuickJS runtime.
 *
 * Returns `{ timeoutSeconds }` when the caller should re-queue the run after
 * a delay (pending waits), or `void` when there is nothing further to do for
 * this invocation (completed, failed, or awaiting external steps/hooks).
 */
export async function runWorkflowWithQuickJS(params: {
  workflowCode: string;
  workflowName: string;
  workflowRun: WorkflowRun;
  /**
   * Run input carried through the queue message on first delivery. Used as a
   * last-resort fallback for `run_created.eventData.input` when the event log
   * is incomplete (eventual consistency right after `start()`).
   */
  runInput?: RunInput;
}): Promise<{ timeoutSeconds?: number } | void> {
  const { workflowCode, workflowName, workflowRun, runInput } = params;
  const world = await getWorld();
  const runId = workflowRun.runId;

  // Strip the inline source map comment before evaluating the bundle in the
  // QuickJS VM. The map is purely host-side metadata for `remapErrorStack`
  // (called below on workflow failures, against the ORIGINAL `workflowCode`).
  // Keeping it out of the VM avoids bloating the QuickJS heap.
  const workflowCodeForVM = stripInlineSourceMap(workflowCode);

  // The workflowName from the queue topic is already the full workflow ID
  // (e.g. "workflow//./workflows/1_simple//simple").
  const workflowId = workflowName;

  // Resolve the encryption key up front — needed to encrypt event payloads
  // produced by the VM (which has no access to the key).
  const rawKey = await world.getEncryptionKeyForRun?.(workflowRun);
  const encryptionKey = rawKey ? await importKey(rawKey) : undefined;

  // Load the FULL event log. We replay from scratch every invocation, so we
  // always need every event (no snapshot/cursor delta). `runInput` covers the
  // run_created read-after-write race when the log is briefly incomplete.
  const { events } = await loadWorkflowRunEvents(runId);

  runtimeLogger.debug('QuickJS runtime: fetched events', {
    workflowRunId: runId,
    eventCount: events.length,
  });

  // Complete any waits that have already elapsed BEFORE running the VM, so the
  // replay observes their wait_completed events.
  const now = Date.now();
  const completedWaitIds = new Set(
    events
      .filter((e) => e.eventType === 'wait_completed')
      .map((e) => e.correlationId)
  );
  for (const event of events) {
    if (
      event.eventType === 'wait_created' &&
      event.correlationId &&
      !completedWaitIds.has(event.correlationId)
    ) {
      const eventData =
        'eventData' in event
          ? (event.eventData as Record<string, unknown>)
          : undefined;
      const resumeAt = eventData?.resumeAt;
      if (resumeAt && now >= new Date(resumeAt as string).getTime()) {
        try {
          const result = await world.events.create(runId, {
            eventType: 'wait_completed',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: event.correlationId,
          });
          if (result.event) events.push(result.event);
        } catch (err) {
          if (EntityConflictError.is(err)) continue;
          throw err;
        }
      }
    }
  }

  // Resolve the workflow server port so `getWorkflowMetadata().url` inside the
  // VM matches what the step-side handler reports. Skipped on Vercel — the VM
  // reads VERCEL_URL directly there.
  const isVercel = process.env.VERCEL_URL !== undefined;
  const port = isVercel ? undefined : await getPort();

  runtimeLogger.debug('QuickJS runtime: invoking VM', {
    workflowRunId: runId,
    workflowId,
    eventCount: events.length,
  });

  const result = await runQuickJSWorkflow({
    // Pass the STRIPPED bundle to the VM; the original (unstripped)
    // `workflowCode` stays host-side for `remapErrorStack` on failures.
    workflowCode: workflowCodeForVM,
    workflowId,
    workflowRun,
    events,
    encryptionKey,
    port,
    runInput,
  });

  runtimeLogger.debug('QuickJS runtime: VM returned', {
    workflowRunId: runId,
    completed: !!result.completed,
    suspended: !!result.suspended,
    failed: !!result.failed,
    pendingOpsCount: result.suspended?.pendingOperations?.length,
  });

  if (result.completed) {
    // Create run_completed. The VM serializes the workflow result as
    // format-prefixed devalue bytes ("devl" + devalue) with no encryption
    // (it has no access to the CryptoKey). Host-side encryption is applied
    // here so run_completed events match the node:vm runtime's payload shape.
    try {
      await world.events.create(runId, {
        eventType: 'run_completed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          output: await encryptSerializedData(
            result.completed.result,
            encryptionKey
          ),
        },
      });
    } catch (err) {
      if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
        runtimeLogger.warn(
          'Workflow already finished, skipping run_completed',
          {
            workflowRunId: runId,
          }
        );
        return;
      }
      throw err;
    }
    return;
  }

  if (result.suspended) {
    const { pendingOperations } = result.suspended;

    runtimeLogger.info('QuickJS runtime: workflow suspended', {
      workflowRunId: runId,
      pendingSteps: pendingOperations.filter((p) => p.type === 'step').length,
      pendingWaits: pendingOperations.filter((p) => p.type === 'wait').length,
    });

    let minTimeoutSeconds: number | undefined;

    // Create events + queue steps for each new pending operation. These fan
    // out in parallel — correlationIds are deterministic across replays, so
    // the world's per-(runId, correlationId) uniqueness dedups duplicates as
    // EntityConflictError (swallowed below).
    const opsPromises: Promise<void>[] = [];
    for (const op of pendingOperations) {
      if (op.type === 'step' && !op.hasCreatedEvent) {
        const step = op as PendingStep;
        opsPromises.push(
          (async () => {
            // `step.input` is format-prefixed devalue bytes from the VM;
            // encrypt host-side (the VM lacks the key).
            try {
              await world.events.create(runId, {
                eventType: 'step_created',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: step.correlationId,
                eventData: {
                  stepName: step.stepId,
                  input: await encryptSerializedData(step.input, encryptionKey),
                },
              });
            } catch (err) {
              if (EntityConflictError.is(err)) return;
              throw err;
            }

            // Queue step execution via the unified workflow queue. The
            // combined handler in runtime.ts dispatches messages with a
            // `stepId` to executeStep — shared with the node:vm runtime.
            const traceCarrier = await serializeTraceCarrier();
            await queueMessage(
              world,
              getWorkflowQueueName(workflowRun.workflowName),
              {
                runId,
                stepId: step.correlationId,
                stepName: step.stepId,
                traceCarrier,
                requestedAt: new Date(),
              },
              {
                idempotencyKey: step.correlationId,
              }
            );
          })()
        );
      } else if (op.type === 'hook' && !op.hasCreatedEvent) {
        const hook = op as PendingHook;
        opsPromises.push(
          (async () => {
            try {
              const encryptedMetadata =
                typeof hook.metadata === 'undefined'
                  ? undefined
                  : await encryptSerializedData(hook.metadata, encryptionKey);
              const result = await world.events.create(runId, {
                eventType: 'hook_created',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: hook.correlationId,
                eventData: {
                  token: hook.token,
                  metadata: encryptedMetadata,
                  // Always include isWebhook explicitly. Worlds default it to
                  // `true` when absent, which would break the public webhook
                  // endpoint's 404 guard for hooks created via createHook().
                  isWebhook: hook.isWebhook,
                } as any,
              });

              // If storage detected a real token conflict with another
              // workflow's hook, re-queue so the runtime can process the
              // conflict event and fail gracefully.
              if (result.event?.eventType === 'hook_conflict') {
                await queueMessage(
                  world,
                  getWorkflowQueueName(workflowRun.workflowName),
                  { runId },
                  { idempotencyKey: `hook_conflict_${hook.correlationId}` }
                );
              }
            } catch (err) {
              if (EntityConflictError.is(err)) return;
              throw err;
            }
          })()
        );
      } else if (op.type === 'hook_dispose' && !op.hasCreatedEvent) {
        opsPromises.push(
          (async () => {
            try {
              await world.events.create(runId, {
                eventType: 'hook_disposed',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: op.correlationId,
              });
            } catch (err) {
              if (EntityConflictError.is(err)) return;
              throw err;
            }
          })()
        );
      } else if (op.type === 'wait' && !op.hasCreatedEvent) {
        const wait = op as PendingWait;
        opsPromises.push(
          (async () => {
            try {
              await world.events.create(runId, {
                eventType: 'wait_created',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: wait.correlationId,
                eventData: {
                  resumeAt: new Date(wait.resumeAt),
                },
              });
            } catch (err) {
              if (EntityConflictError.is(err)) return;
              throw err;
            }
          })()
        );
      }
    }
    await Promise.all(opsPromises);

    // Handle pending waits (new and pre-existing). For each: complete it if
    // elapsed (and re-queue), otherwise track the soonest timeout.
    let needsRequeue = false;
    const waitCompletePromises: Promise<void>[] = [];
    for (const op of pendingOperations) {
      if (op.type !== 'wait') continue;
      const wait = op as PendingWait;
      const resumeMs = new Date(wait.resumeAt).getTime() - Date.now();

      if (resumeMs <= 0) {
        waitCompletePromises.push(
          (async () => {
            try {
              await world.events.create(runId, {
                eventType: 'wait_completed',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: wait.correlationId,
              });
              needsRequeue = true;
            } catch (err) {
              if (EntityConflictError.is(err)) return;
              throw err;
            }
          })()
        );
      } else {
        const timeoutSeconds = Math.max(1, Math.ceil(resumeMs / 1000));
        if (
          minTimeoutSeconds === undefined ||
          timeoutSeconds < minTimeoutSeconds
        ) {
          minTimeoutSeconds = timeoutSeconds;
        }
      }
    }
    if (waitCompletePromises.length > 0) {
      await Promise.all(waitCompletePromises);
    }

    if (needsRequeue) {
      // An elapsed wait was completed — re-queue immediately so the runtime
      // can process the wait_completed event.
      return { timeoutSeconds: 0 };
    }

    if (minTimeoutSeconds !== undefined) {
      return { timeoutSeconds: minTimeoutSeconds };
    }

    // Suspended awaiting external steps/hooks — nothing to schedule.
    return;
  }

  if (result.failed) {
    // Remap the stack trace using the inline source map (host-side only).
    let errorStack = result.failed.stack;
    if (errorStack) {
      const parsedName = parseWorkflowName(workflowName);
      const filename = parsedName?.moduleSpecifier || workflowName;
      errorStack = remapErrorStack(errorStack, filename, workflowCode);
    }

    // Reconstruct a host-side Error of the right class from the VM-side name
    // so classifyRunError() tags WorkflowRuntimeError subclasses correctly.
    const reconstructed: Error =
      result.failed.name === 'WorkflowNotRegisteredError'
        ? new WorkflowNotRegisteredError(workflowName)
        : result.failed.name === 'Error'
          ? new Error(result.failed.message)
          : Object.assign(new Error(result.failed.message), {
              name: result.failed.name,
            });
    const errorCode = classifyRunError(reconstructed);

    runtimeLogger.error('QuickJS runtime: workflow failed', {
      workflowRunId: runId,
      errorName: result.failed.name,
      errorMessage: result.failed.message,
      errorStack,
      errorCode,
    });

    // Serialize the error through the dehydration pipeline so consumers get
    // the same hydrated value shape as the node:vm runtime. Two paths:
    //   * valueBytes present: the VM serialized the original thrown value;
    //     hydrate, remap stacks (incl. the cause chain), re-dehydrate.
    //   * legacy fallback: reconstruct from {name, message, stack}.
    let dehydratedError: Uint8Array;
    if (result.failed.valueBytes) {
      try {
        const hydrated = await hydrateRunError(
          result.failed.valueBytes,
          runId,
          undefined // VM bytes are unencrypted
        );
        const parsedName = parseWorkflowName(workflowName);
        const filename = parsedName?.moduleSpecifier || workflowName;
        if (
          hydrated &&
          typeof hydrated === 'object' &&
          typeof (hydrated as { stack?: unknown }).stack === 'string'
        ) {
          (hydrated as { stack?: string }).stack = remapErrorStack(
            (hydrated as { stack: string }).stack,
            filename,
            workflowCode
          );
        }
        // Walk the cause chain and remap nested stacks too.
        const seen = new WeakSet<object>();
        let node = (hydrated as { cause?: unknown })?.cause;
        while (node && typeof node === 'object' && !seen.has(node as object)) {
          seen.add(node as object);
          const nodeStack = (node as { stack?: unknown }).stack;
          if (typeof nodeStack === 'string') {
            (node as { stack?: string }).stack = remapErrorStack(
              nodeStack,
              filename,
              workflowCode
            );
          }
          node = (node as { cause?: unknown }).cause;
        }
        dehydratedError = await dehydrateRunError(
          hydrated,
          runId,
          encryptionKey
        );
      } catch (rehydrateErr) {
        // If hydration / re-dehydration fails, pass the original VM bytes
        // through (applying encryption if configured). Better to lose
        // source-mapped frames than the error entirely.
        runtimeLogger.warn(
          'QuickJS runtime: failed to remap workflow error stack, passing VM bytes through',
          {
            workflowRunId: runId,
            message: (rehydrateErr as Error)?.message,
          }
        );
        dehydratedError = (await maybeEncrypt(
          result.failed.valueBytes,
          encryptionKey
        )) as Uint8Array;
      }
    } else {
      if (errorStack) {
        reconstructed.stack = errorStack;
      }
      try {
        dehydratedError = await dehydrateRunError(
          reconstructed,
          runId,
          encryptionKey
        );
      } catch (serErr) {
        runtimeLogger.warn(
          'QuickJS runtime: failed to dehydrate run error, falling back to bare Error',
          { workflowRunId: runId, message: (serErr as Error)?.message }
        );
        dehydratedError = await dehydrateRunError(
          Object.assign(new Error(result.failed.message), {
            name: result.failed.name,
          }),
          runId,
          encryptionKey
        );
      }
    }

    try {
      await world.events.create(runId, {
        eventType: 'run_failed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          error: dehydratedError,
          errorCode,
        },
      });
    } catch (err) {
      if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
        runtimeLogger.warn('Workflow already finished, skipping run_failed', {
          workflowRunId: runId,
        });
        return;
      }
      throw err;
    }
  }
}
