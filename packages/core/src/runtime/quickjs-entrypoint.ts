/**
 * QuickJS VM integration with the Workflow DevKit.
 *
 * This module provides the entry point for running workflows in the
 * QuickJS WASM VM engine instead of the `node:vm` engine. Both engines
 * implement the same event-replay execution model — every invocation:
 *
 * 1. Loads the full event log for the run
 * 2. Runs the workflow function from the top in a fresh QuickJS VM,
 *    replaying the event log to resolve awaited primitives
 * 3. On suspension: creates events + queues steps for new pending ops
 * 4. On completion: creates run_completed
 * 5. On failure: creates run_failed
 */

import type { Span } from '@opentelemetry/api';
import {
  EntityConflictError,
  RunExpiredError,
  WorkflowNotRegisteredError,
} from '@workflow/errors';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type Event,
  type RunInput,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { classifyRunError } from '../classify-error.js';
import { importKey } from '../encryption.js';
import { runtimeLogger } from '../logger.js';
import {
  dehydrateRunError,
  hydrateRunError,
  maybeEncrypt,
} from '../serialization.js';
import { encrypt as encryptSerializedData } from '../serialization/encryption.js';
import { remapErrorStack, stripInlineSourceMap } from '../source-map.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { serializeTraceCarrier } from '../telemetry.js';
import { getPortLazy } from './get-port-lazy.js';
import { getWorkflowQueueName, queueMessage } from './helpers.js';
import {
  type PendingAttribute,
  type PendingHook,
  type PendingStep,
  type PendingWait,
  runQuickJSWorkflow,
} from './quickjs-runtime.js';
import { getWorld } from './world.js';

/** Tiny ms timer using performance.now() — already monotonic on Node. */
function tick(): number {
  return performance.now();
}

/**
 * Returns true when the supplied preloaded events indicate this is the
 * first workflow handler invocation for the run — i.e. the log contains
 * nothing beyond `run_created` / `run_started`. In that case the
 * preloaded events ARE the complete event log and the `events.list`
 * round-trips can be skipped entirely.
 *
 * Crucially, if the world backfilled a missing `run_created` via the
 * resilient start path, `preloadedEvents` contains it even when a fresh
 * `events.list` might not (eventual consistency), so preferring the
 * preloaded events on first invocation is also the more correct choice.
 *
 * Returns false when `preloadedEvents` is missing/empty so the caller
 * falls back to the normal fetch path.
 *
 * Exported for unit testing.
 */
export function isFirstInvocation(
  preloadedEvents: readonly Event[] | undefined
): boolean {
  if (!Array.isArray(preloadedEvents) || preloadedEvents.length === 0) {
    return false;
  }
  return preloadedEvents.every(
    (e) => e.eventType === 'run_created' || e.eventType === 'run_started'
  );
}

/**
 * Run a workflow using the QuickJS WASM VM engine.
 *
 * This replaces the `node:vm` replay path (runWorkflow + EventsConsumer)
 * with a QuickJS VM invocation that performs the same full event replay.
 */
export async function runWorkflowWithQuickJS(params: {
  workflowCode: string;
  workflowName: string;
  workflowRun: WorkflowRun;
  /**
   * Events returned inline by `events.create('run_started', ...)`. When
   * they indicate a first invocation, they are used as the event log
   * instead of fetching via `events.list`, matching the node:vm engine's
   * fast path.
   */
  preloadedEvents?: Event[];
  /**
   * Run input carried through the queue message on first delivery. Used
   * as a last-resort fallback for `run_created.eventData.input` when
   * the event log is incomplete.
   */
  runInput?: RunInput;
  /**
   * The parent OTel span (the outer `WORKFLOW {workflowName}` span from
   * `runtime.ts`). When supplied, VM lifecycle attributes are attached
   * to it for end-to-end visibility.
   */
  parentSpan?: Span;
}): Promise<{ timeoutSeconds?: number } | void> {
  const {
    workflowCode,
    workflowName,
    workflowRun,
    preloadedEvents,
    runInput,
    parentSpan,
  } = params;
  const world = await getWorld();
  const runId = workflowRun.runId;
  const invocationStart = tick();

  // Strip the inline source map comment before evaluating the bundle in
  // the QuickJS VM. The map is purely host-side metadata for
  // `remapErrorStack` (called below on workflow failures, against the
  // ORIGINAL `workflowCode`). QuickJS retains source text for
  // stack-trace line lookups, so the few-MB base64 comment would bloat
  // the VM heap for no benefit.
  const workflowCodeForVM = stripInlineSourceMap(workflowCode);

  // Per-invocation diagnostic id so debug logs can be correlated even if
  // the same runId is processed by overlapping invocations on different
  // function instances.
  const invocationId = `inv_${Math.random().toString(36).slice(2, 10)}`;

  // Structured per-checkpoint diagnostic helper, grep-friendly by runId.
  const wfdiag = (checkpoint: string, fields: Record<string, unknown>) => {
    runtimeLogger.debug('QUICKJS_VM_DIAG', {
      checkpoint,
      runId,
      invocationId,
      tElapsedMs: Math.round(tick() - invocationStart),
      ...fields,
    });
  };

  parentSpan?.setAttributes({
    ...Attribute.WorkflowVm('quickjs'),
  });

  wfdiag('enter', {
    workflowName,
    hasPreloadedEvents:
      Array.isArray(preloadedEvents) && preloadedEvents.length > 0,
    preloadedEventCount: preloadedEvents?.length ?? 0,
    hasRunInput: !!runInput,
  });

  // The workflowName from the queue topic is already the full workflow ID
  // (e.g. "workflow//./workflows/1_simple//simple")
  const workflowId = workflowName;

  // Resolve the encryption key up front — needed to decrypt event
  // payloads inside the VM and to encrypt event payloads written below.
  const rawKey = await world.getEncryptionKeyForRun?.(workflowRun);
  const encryptionKey = rawKey ? await importKey(rawKey) : undefined;

  // Load the FULL event log for the run. On first invocation the
  // preloaded events from the run_started response are the complete log
  // and save the events.list round-trips.
  let events: Event[];
  let eventsFetchedPages = 0;
  const usePreloaded = isFirstInvocation(preloadedEvents);
  if (usePreloaded && preloadedEvents) {
    events = preloadedEvents;
  } else {
    const allEvents: Event[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const response = await world.events.list({
        runId,
        pagination: {
          sortOrder: 'asc',
          cursor: cursor ?? undefined,
          limit: 1000,
        },
      });
      eventsFetchedPages++;
      allEvents.push(...response.data);
      // Update the cursor to the last successfully fetched page's cursor.
      // Only update when we got results — the final empty-page response
      // returns cursor=null which we must NOT use (it would reset the cursor).
      if (response.cursor) {
        cursor = response.cursor;
      }
      hasMore = response.data.length > 0 && response.cursor != null;
    }

    events = allEvents;
  }

  parentSpan?.setAttributes({
    ...Attribute.QuickJSEventsPreloaded(usePreloaded),
    ...Attribute.QuickJSEventsFetchedCount(events.length),
    ...Attribute.QuickJSEventsFetchedPages(eventsFetchedPages),
  });

  wfdiag('events_fetched', {
    eventCount: events.length,
    eventsFetchedPages,
    usePreloaded,
    eventTypes: events.reduce<Record<string, number>>((acc, e) => {
      acc[e.eventType] = (acc[e.eventType] ?? 0) + 1;
      return acc;
    }, {}),
  });

  // Check for elapsed waits
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

  // Resolve the workflow server port so `getWorkflowMetadata().url` inside
  // the VM matches what the step-side handler reports. Skipped on Vercel —
  // the VM reads VERCEL_URL directly in that environment.
  const isVercel = process.env.VERCEL_URL !== undefined;
  const port = isVercel ? undefined : await getPortLazy();

  // Run the workflow in the QuickJS VM
  runtimeLogger.debug('QuickJS runtime: invoking VM', {
    workflowRunId: runId,
    workflowId,
    eventCount: events.length,
  });

  const result = await runQuickJSWorkflow({
    // Pass the STRIPPED bundle to the VM so the inline source map
    // doesn't end up in the QuickJS heap. The original (unstripped)
    // `workflowCode` is still kept in this host-side scope and is used
    // by `remapErrorStack` on workflow failures below.
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

  wfdiag('vm_returned', {
    outcome: result.completed
      ? 'completed'
      : result.suspended
        ? 'suspended'
        : result.failed
          ? 'failed'
          : 'unknown',
    pendingOpsCount: result.suspended?.pendingOperations?.length ?? 0,
    pendingOpSummary: result.suspended?.pendingOperations?.map((p) => ({
      type: p.type,
      correlationId: p.correlationId,
      hasCreatedEvent: p.hasCreatedEvent,
      ...(p.type === 'step' ? { stepId: (p as PendingStep).stepId } : {}),
    })),
    failureMessage: result.failed?.message,
    failureName: result.failed?.name,
  });

  if (result.completed) {
    // Workflow completed
    runtimeLogger.info('QuickJS runtime: workflow completed', {
      workflowRunId: runId,
    });
    parentSpan?.setAttributes({
      ...Attribute.QuickJSOutcome('completed'),
    });

    // Create run_completed event.
    // The VM serializes the workflow result as format-prefixed devalue bytes
    // ("devl" + devalue) with no encryption (the VM has no access to the
    // CryptoKey). Host-side encryption is applied here so that `run_completed`
    // events have the same `encr`-prefixed payload shape that the node:vm
    // engine's `dehydrateWorkflowReturnValue` produces.
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
      wfdiag('exit_completed', { result: 'run_completed_written' });
    } catch (err) {
      if (EntityConflictError.is(err) || RunExpiredError.is(err)) {
        runtimeLogger.warn(
          'Workflow already finished, skipping run_completed',
          { workflowRunId: runId }
        );
        wfdiag('exit_completed', { result: 'already_finished' });
        return;
      }
      wfdiag('exit_completed_error', {
        errorName: (err as Error)?.name,
        errorMessage: (err as Error)?.message,
      });
      throw err;
    }
  } else if (result.suspended) {
    // Workflow suspended
    const { pendingOperations } = result.suspended;

    runtimeLogger.info('QuickJS runtime: workflow suspended', {
      workflowRunId: runId,
      pendingSteps: pendingOperations.filter((p) => p.type === 'step').length,
      pendingWaits: pendingOperations.filter((p) => p.type === 'wait').length,
      pendingOps: pendingOperations.map((p) => ({
        type: p.type,
        correlationId: p.correlationId,
        hasCreatedEvent: p.hasCreatedEvent,
        ...(p.type === 'step'
          ? {
              stepId: (p as PendingStep).stepId,
              inputType: typeof (p as PendingStep).input,
              inputIsUint8Array: (p as PendingStep).input instanceof Uint8Array,
            }
          : {}),
      })),
    });

    parentSpan?.setAttributes({
      ...Attribute.QuickJSOutcome('suspended'),
      ...Attribute.QuickJSPendingOpsCount(pendingOperations.length),
    });

    // Build per-pending-op promises so events.create + queueMessage
    // calls fan out in parallel rather than serially. This mirrors
    // the node:vm engine's `Promise.all(ops)` pattern in
    // suspension-handler.ts and significantly reduces wall-clock time
    // on cloud worlds (e.g. Vercel) where each storage call is a
    // network round-trip.
    let minTimeoutSeconds: number | undefined;
    // Set when a new attr_set event is written this invocation. The
    // workflow must be re-invoked to consume it (resolving the pending
    // setAttributes() promise), so the entrypoint requeues immediately —
    // same pattern as an elapsed wait.
    let createdAttributeEvent = false;
    const opsPromises: Promise<void>[] = [];

    for (const op of pendingOperations) {
      if (op.type === 'step' && !op.hasCreatedEvent) {
        const step = op as PendingStep;
        opsPromises.push(
          (async () => {
            // Create step_created event. `step.input` is the
            // format-prefixed devalue bytes ("devl" + devalue) produced
            // by `globalThis[Symbol.for('workflow-serialize')]({args,
            // closureVars, thisVal})` inside the VM. The VM has no
            // access to the CryptoKey, so encryption is applied here
            // on the host side — matching what
            // `dehydrateStepArguments` does in the node:vm engine.
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

            // Queue the step execution via the unified workflow queue
            // (V2 architecture). The combined handler in runtime.ts
            // dispatches messages with `stepId` to executeStep, which
            // works for both VM engines — so the QuickJS engine reuses
            // the same step execution path as the node:vm engine
            // instead of needing a separate step route.
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
            wfdiag('step_queued', {
              stepId: step.stepId,
              correlationId: step.correlationId,
            });
          })()
        );
      } else if (op.type === 'hook' && !op.hasCreatedEvent) {
        const hook = op as PendingHook;
        runtimeLogger.debug('QuickJS runtime: creating hook_created event', {
          workflowRunId: runId,
          correlationId: hook.correlationId,
          token: hook.token,
          tokenType: typeof hook.token,
          isWebhook: hook.isWebhook,
        });

        opsPromises.push(
          (async () => {
            // `hook.metadata` is the format-prefixed devalue bytes
            // produced by `globalThis[Symbol.for('workflow-serialize')]
            // (options.metadata)` inside the VM. Encrypt on the host
            // side before writing — matches the node:vm engine's
            // `dehydrateStepArguments` flow.
            //
            // No pre-check via hooks.list: with deterministic correlationIds
            // (same VM seed across replays) and per-(runId, correlationId)
            // uniqueness in worlds, the storage layer rejects duplicates as
            // EntityConflictError, which we swallow below. This drops one
            // network round-trip per pending hook.
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
              // workflow's hook, re-queue so the workflow handler can
              // process the conflict event and fail gracefully.
              if (result.event?.eventType === 'hook_conflict') {
                await queueMessage(
                  world,
                  `__wkf_workflow_${workflowRun.workflowName}`,
                  {
                    runId,
                  },
                  { idempotencyKey: `hook_conflict_${hook.correlationId}` }
                );
              }
            } catch (err) {
              if (EntityConflictError.is(err)) return;
              throw err;
            }
          })()
        );
      } else if (op.type === 'attribute' && !op.hasCreatedEvent) {
        const attr = op as PendingAttribute;
        opsPromises.push(
          (async () => {
            try {
              await world.events.create(runId, {
                eventType: 'attr_set',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: attr.correlationId,
                eventData: {
                  changes: attr.changes,
                  writer: { type: 'workflow' },
                  ...(attr.allowReservedAttributes
                    ? { allowReservedAttributes: true }
                    : {}),
                } as any,
              });
              createdAttributeEvent = true;
            } catch (err) {
              if (EntityConflictError.is(err)) {
                // Event already exists (concurrent invocation) — the
                // replay still needs to consume it, so requeue.
                createdAttributeEvent = true;
                return;
              }
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

    // Per-op dispatch runs in parallel.
    await Promise.all(opsPromises);

    // Handle pending waits — both newly created and still-pending from
    // earlier invocations. For each wait, either create a wait_completed
    // event (if elapsed) or schedule a timeout for re-queuing.
    let needsRequeue = false;
    const waitCompletePromises: Promise<void>[] = [];
    for (const op of pendingOperations) {
      if (op.type !== 'wait') continue;
      const wait = op as PendingWait;
      const resumeMs = new Date(wait.resumeAt).getTime() - Date.now();

      if (resumeMs <= 0) {
        // Wait has elapsed — create wait_completed and re-queue.
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
        // Wait hasn't elapsed yet — schedule a timeout
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

    if (needsRequeue || createdAttributeEvent) {
      // An elapsed wait was completed or a new attr_set event was
      // written — re-queue immediately so the next invocation can
      // process the new event.
      wfdiag('exit_suspended', {
        action: needsRequeue ? 'wait_elapsed_requeue' : 'attr_set_requeue',
        timeoutSeconds: 0,
      });
      return { timeoutSeconds: 0 };
    }

    if (minTimeoutSeconds !== undefined) {
      wfdiag('exit_suspended', {
        action: 'schedule_wait_timeout',
        timeoutSeconds: minTimeoutSeconds,
      });
      return { timeoutSeconds: minTimeoutSeconds };
    }

    wfdiag('exit_suspended', {
      action: 'awaiting_external',
      pendingOpsCount: pendingOperations.length,
    });
  } else if (result.failed) {
    // Workflow failed — remap stack trace using inline source maps
    let errorStack = result.failed.stack;
    if (errorStack) {
      const parsedName = parseWorkflowName(workflowName);
      const filename = parsedName?.moduleSpecifier || workflowName;
      errorStack = remapErrorStack(errorStack, filename, workflowCode);
    }

    // Classify the error so consumers (`run.returnValue`, observability)
    // get `USER_ERROR` / `RUNTIME_ERROR` on `error.cause.code`, matching
    // what the node:vm engine already does in runtime.ts.
    //
    // The VM serializes errors as `{ name, message, stack }`, so we
    // reconstruct a host-side Error of the correct class based on the
    // VM-side `name` — specific WorkflowRuntimeError subclasses need
    // to be preserved so classifyRunError() tags them as RUNTIME_ERROR.
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
    parentSpan?.setAttributes({
      ...Attribute.QuickJSOutcome('failed'),
    });

    // Create run_failed event. Serialize the error through the
    // first-class dehydration pipeline so consumers (CLI, observability,
    // run.returnValue) get the same hydrated value shape as the node:vm
    // engine emits. Two paths:
    //   * Modern (valueBytes present): the VM-side rejection handler
    //     serialized the original thrown value (Error subclass with
    //     cause chain, plain object, primitive, etc.) using the VM's
    //     workflow-serialize. Pass those bytes through directly so
    //     type identity, cause chains, and non-Error throws survive.
    //     We just need to apply encryption if configured (the VM's
    //     serializer doesn't have access to the encryption key).
    //   * Legacy fallback: reconstruct an Error from the host-visible
    //     {name, message, stack} fields and run it through
    //     `dehydrateRunError`. Used when valueBytes is absent (e.g.
    //     extractError pseudo-failures from VM bootstrap).
    let dehydratedError: Uint8Array;
    if (result.failed.valueBytes) {
      // Hydrate the VM-side bytes, remap the error stack with the
      // host-side source map (the VM can't do this — it lacks both the
      // source map and `remapErrorStack`), and re-dehydrate. This
      // preserves the original value's type identity / cause chain
      // while fixing up frames to point at the user's source files.
      try {
        const hydrated = await hydrateRunError(
          result.failed.valueBytes,
          runId,
          undefined // VM bytes are unencrypted
        );
        if (
          hydrated &&
          typeof hydrated === 'object' &&
          'stack' in (hydrated as object) &&
          typeof (hydrated as { stack?: unknown }).stack === 'string'
        ) {
          const parsedName = parseWorkflowName(workflowName);
          const filename = parsedName?.moduleSpecifier || workflowName;
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
            const parsedName = parseWorkflowName(workflowName);
            const filename = parsedName?.moduleSpecifier || workflowName;
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
        // If hydration / re-dehydration fails for any reason, fall
        // back to passing through the original VM bytes (just apply
        // encryption if configured). Better to lose source-mapped
        // frames than to lose the error entirely.
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
        // Fall back to a minimal payload so the run still terminates
        // even when the error itself contains unserializable values.
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
        wfdiag('exit_failed', { result: 'already_finished' });
        return;
      }
      wfdiag('exit_failed_error', {
        errorName: (err as Error)?.name,
        errorMessage: (err as Error)?.message,
      });
      throw err;
    }
    wfdiag('exit_failed', { result: 'run_failed_written' });
  }
}
