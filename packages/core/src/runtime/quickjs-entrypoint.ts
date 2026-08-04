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
  FatalError,
  HookNotFoundError,
  MaxEventsExceededError,
  RunExpiredError,
  WorkflowNotRegisteredError,
} from '@workflow/errors';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type Event,
  type RunInput,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type WorldCapabilities,
} from '@workflow/world';
import { classifyRunError } from '../classify-error.js';
import { runtimeLogger } from '../logger.js';
import {
  deriveRunPayloadKeys,
  encrypt as encryptSerializedData,
  type RunPayloadKeys,
} from '../serialization/encryption.js';
import {
  dehydrateRunError,
  hydrateRunError,
  maybeEncrypt,
} from '../serialization.js';
import { remapErrorStack, stripInlineSourceMap } from '../source-map.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { serializeTraceCarrier } from '../telemetry.js';
import { getPortLazy } from './get-port-lazy.js';
import { getWorkflowQueueName, queueMessage } from './helpers.js';
import {
  type PendingAttribute,
  type PendingHook,
  type PendingHookDispose,
  type PendingOperation,
  type PendingStep,
  type PendingWait,
  runQuickJSWorkflow,
} from './quickjs-runtime.js';
import { getWaitContinuationDispatch } from './wait-continuation.js';
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
 * Dispatch durable side effects for a set of pending VM operations:
 * step_created (+ optional queueing), hook_created / hook_received (aborts),
 * attr_set, hook_disposed, and wait_created events.
 *
 * Used in two modes:
 *  - suspension (queueSteps: true): normal suspension processing; new steps
 *    are queued for execution.
 *  - terminal drain (queueSteps: false): flush leftover side effects when
 *    the workflow completed or failed — mirrors the node:vm engine's
 *    drainPendingQueueItems. Steps are created but NOT queued, and the run
 *    is never requeued.
 */
/**
 * Rejects retained Hooks before registration when the configured World
 * does not support `experimental_minRetention` — the same gate the node
 * engine applies inside `createHook()` (workflow/hook.ts), where
 * `ctx.worldCapabilities` is available to workflow code. The QuickJS VM
 * has no capability channel into the guest, so the check runs host-side
 * at dispatch, before any `hook_created` is written. Without it, a
 * non-supporting world would silently persist the hook WITHOUT its
 * retention deadline — the user asked for retention, got none, and
 * nothing failed loud (see WorldCapabilities.hookRetention in
 * @workflow/world: "Missing or inactive means the runtime rejects
 * retained Hooks before registration").
 *
 * The FatalError escapes the entrypoint into the replay loop's catch in
 * runtime.ts, which records run_failed — mirroring the node engine,
 * where the same FatalError fails the run from inside the workflow.
 */
export function assertHookRetentionSupported(
  pendingOperations: PendingOperation[],
  capabilities: WorldCapabilities | undefined
): void {
  if (capabilities?.hookRetention?.active === true) return;
  for (const op of pendingOperations) {
    if (
      op.type === 'hook' &&
      (op as PendingHook).tokenRetentionUntil !== undefined
    ) {
      throw new FatalError(
        'The configured World does not support `experimental_minRetention` for Hooks.'
      );
    }
  }
}

async function dispatchPendingOps(params: {
  world: Awaited<ReturnType<typeof getWorld>>;
  runId: string;
  workflowRun: WorkflowRun;
  encryptionKey: RunPayloadKeys | undefined;
  pendingOperations: PendingOperation[];
  queueSteps: boolean;
  /** Queue namespace for all message publishes (see runtime.ts). */
  namespace: string | undefined;
  /**
   * Run-origin trace carrier accessor from runtime.ts. In the default
   * `linked` trace mode this returns the carrier of the run's ORIGIN
   * context (workflow.start), so every invocation links back to the
   * start in a star — capturing the current context here instead would
   * chain invocations to each other and fragment the run view on async
   * queues.
   */
  nextTraceCarrier: () => Promise<Record<string, string>>;
  wfdiag: (checkpoint: string, fields: Record<string, unknown>) => void;
}): Promise<{
  createdAttributeEvent: boolean;
  createdGetConflictHook: boolean;
}> {
  const {
    world,
    runId,
    workflowRun,
    encryptionKey,
    pendingOperations,
    namespace,
    nextTraceCarrier,
  } = params;
  const wfdiag = params.wfdiag;
  // Set when a hook with a parked getConflict() awaiter had its
  // hook_created written this invocation. The workflow must be re-invoked
  // so replay can confirm creation and resolve the awaiter.
  let createdGetConflictHook = false;
  // Set when a new attr_set event is written this invocation. The
  // workflow must be re-invoked to consume it (resolving the pending
  // setAttributes() promise), so the entrypoint requeues immediately —
  // same pattern as an elapsed wait.
  let createdAttributeEvent = false;
  const opsPromises: Promise<void>[] = [];

  assertHookRetentionSupported(pendingOperations, world.capabilities);

  const processHookOp = async (hook: PendingHook): Promise<void> => {
    runtimeLogger.debug('QuickJS runtime: processing hook op', {
      workflowRunId: runId,
      correlationId: hook.correlationId,
      token: hook.token,
      tokenType: typeof hook.token,
      isWebhook: hook.isWebhook,
      isSystem: hook.isSystem,
      hasCreatedEvent: hook.hasCreatedEvent,
      abortRequested: hook.abortRequested,
    });

    if (!hook.hasCreatedEvent) {
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
            tokenRetentionUntil:
              hook.tokenRetentionUntil === undefined
                ? undefined
                : new Date(hook.tokenRetentionUntil),
            metadata: encryptedMetadata,
            // Always include isWebhook explicitly. Worlds default it to
            // `true` when absent, which would break the public webhook
            // endpoint's 404 guard for hooks created via createHook().
            isWebhook: hook.isWebhook,
            // System hooks (AbortController) are exempt from user
            // token namespace conflict checks.
            ...(hook.isSystem ? { isSystem: true } : {}),
          } as any,
        });

        // If storage detected a real token conflict with another
        // workflow's hook, re-queue so the workflow handler can
        // process the conflict event and fail gracefully.
        if (result.event?.eventType === 'hook_conflict') {
          await queueMessage(
            world,
            getWorkflowQueueName(workflowRun.workflowName, namespace),
            {
              runId,
              traceCarrier: await nextTraceCarrier(),
              requestedAt: new Date(),
            },
            { idempotencyKey: `hook_conflict_${hook.correlationId}` }
          );
        }
      } catch (err) {
        // Already created by a concurrent invocation — fall through
        // to abort processing below (if any) instead of bailing.
        if (!EntityConflictError.is(err)) throw err;
      }
      if (hook.hasGetConflictAwaiter) {
        createdGetConflictHook = true;
      }
    }

    if (hook.abortRequested) {
      // Record the abort durably: a hook_received event carrying
      // the VM-serialized `{ aborted: true, reason }` payload,
      // plus a best-effort stream packet for real-time step
      // propagation. Mirrors the node:vm engine's suspension
      // handler (hooksNeedingAbort).
      const abortPayload =
        hook.abortPayload instanceof Uint8Array
          ? ((await encryptSerializedData(
              hook.abortPayload,
              encryptionKey
            )) as Uint8Array)
          : undefined;
      try {
        await world.events.create(runId, {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hook.correlationId,
          eventData: {
            token: hook.token,
            payload: abortPayload,
          } as any,
        });
      } catch (err) {
        if (!EntityConflictError.is(err)) throw err;
      }
      // streamName is derived from the abort hook token
      // (`abrt_{id}` → `strm_{id}_system_abort`).
      if (hook.token.startsWith('abrt_') && abortPayload) {
        const streamName = `strm_${hook.token.slice('abrt_'.length)}_system_abort`;
        try {
          await world.streams.write(runId, streamName, abortPayload);
          await world.streams.close(runId, streamName);
        } catch {
          // Best-effort — the hook event provides the durable
          // fallback.
          runtimeLogger.debug(
            'QuickJS runtime: failed to write abort stream packet',
            {
              workflowRunId: runId,
              correlationId: hook.correlationId,
            }
          );
        }
      }
      wfdiag('abort_recorded', {
        correlationId: hook.correlationId,
        token: hook.token,
      });
    }
  };

  const processHookDisposeOp = async (
    op: PendingHookDispose
  ): Promise<void> => {
    try {
      await world.events.create(runId, {
        eventType: 'hook_disposed',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: op.correlationId,
      });
    } catch (err) {
      if (EntityConflictError.is(err)) return;
      // Disposing a hook whose entity no longer (or never) exists is an
      // idempotent no-op: the entity may have been torn down by a
      // concurrent run cancellation, or the hook may have lost its
      // token claim to a conflict. There is nothing left to release.
      if (HookNotFoundError.is(err)) return;
      throw err;
    }
  };

  // Hook operations are grouped by token and processed SEQUENTIALLY in
  // code order within each group, mirroring the node:vm suspension
  // handler (hookItemsByToken): a dispose() of an earlier hook must
  // release the token before a later same-token hook's creation is
  // validated by the world — parallel dispatch would otherwise record a
  // spurious hook_conflict against the run's own disposed hook (e.g. a
  // dispose→recreate loop reusing one token). Different tokens have no
  // claim interaction, so token groups run in parallel with each other,
  // but the whole hook phase is awaited before any step/wait op is issued
  // (see the barrier below).
  const hookOpsByToken = new Map<
    string,
    (PendingHook | PendingHookDispose)[]
  >();
  for (const op of pendingOperations) {
    let key: string | undefined;
    if (
      op.type === 'hook' &&
      (!op.hasCreatedEvent || (op as PendingHook).abortRequested)
    ) {
      key = (op as PendingHook).token;
    } else if (op.type === 'hook_dispose' && !op.hasCreatedEvent) {
      // Per-op fallback group when the token is unknown — no ordering
      // guarantees, matching the previous parallel behavior.
      key = (op as PendingHookDispose).token ?? `__cid:${op.correlationId}`;
    }
    if (key === undefined) continue;
    const group = hookOpsByToken.get(key);
    if (group) {
      group.push(op as PendingHook | PendingHookDispose);
    } else {
      hookOpsByToken.set(key, [op as PendingHook | PendingHookDispose]);
    }
  }
  const hookPhasePromises: Promise<void>[] = [];
  for (const group of hookOpsByToken.values()) {
    hookPhasePromises.push(
      (async () => {
        for (const op of group) {
          if (op.type === 'hook') {
            await processHookOp(op);
          } else {
            await processHookDisposeOp(op);
          }
        }
      })()
    );
  }
  // Barrier: every hook_created is durable before any step is dispatched.
  // This mirrors the node:vm suspension handler, which settles its hook
  // phase before the step phase. A step that receives an AbortSignal can
  // call controller.abort() as soon as it starts running, and that resume
  // targets the abort controller's hook by token: if the hook row does not
  // exist yet the resume throws HookNotFoundError and the abort is lost
  // (serialization.ts treats the resume as best-effort). Dispatching steps
  // concurrently with hook creation makes that a race decided by write
  // latency.
  if (hookPhasePromises.length > 0) {
    // Settle rather than Promise.all so a rejecting group cannot leave its
    // siblings' in-flight writes as unhandled rejections.
    const rejections = (await Promise.allSettled(hookPhasePromises))
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    if (rejections.length > 0) {
      throw rejections[0];
    }
  }

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
          // instead of needing a separate step route. Skipped in
          // terminal-drain mode (the workflow already finished; the
          // event is the durable record, matching the node:vm drain).
          if (params.queueSteps) {
            const traceCarrier = await nextTraceCarrier();
            await queueMessage(
              world,
              getWorkflowQueueName(workflowRun.workflowName, namespace),
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

  return { createdAttributeEvent, createdGetConflictHook };
}

/**
 * Run a workflow using the QuickJS WASM VM engine.
 *
 * This replaces the `node:vm` replay path (runWorkflow + EventsConsumer)
 * with a QuickJS VM invocation that performs the same full event replay.
 *
 * KNOWN GAP — precondition guard: unlike the node:vm path, no event write
 * in this file participates in the optimistic-concurrency precondition
 * guard (`withPreconditionRetry` + `stateUpdatedAtForCreate`), which
 * protects a writer holding a stale event-log snapshot from clobbering a
 * concurrent one. The engine currently relies on per-(runId,
 * correlationId) event uniqueness (EntityConflictError dedup) alone. This
 * is a deliberate simplification while the engine is experimental — wiring
 * the guard is tracked follow-up work; anyone adding new write paths here
 * should not assume parity with the node engine on this axis.
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
  /**
   * Server-supplied per-run event ceiling from the run_started response
   * (undefined ⇒ no enforcement). Mirrors the node:vm engine's guard:
   * a runaway run is failed once its log reaches the ceiling. The throw
   * propagates to the replay loop's catch in runtime.ts (the QuickJS
   * dispatch runs inside that loop's try), which classifies it and
   * records run_failed with MAX_EVENTS_EXCEEDED.
   */
  maxEventsLimit?: number;
  /**
   * Queue namespace resolved at route registration (runtime.ts). Must be
   * threaded into every message publish: the builders bake the namespace
   * into generated routes, so consumers listen on `__<ns>_wkf_workflow_*`
   * — a publish without it lands on `__wkf_workflow_*` and is never
   * picked up.
   */
  namespace?: string;
  /**
   * Run-origin trace carrier accessor from runtime.ts
   * (getNextTraceCarrier). In the default `linked` trace mode every
   * invocation must link back to the run's origin (workflow.start) in a
   * star; capturing the current invocation context instead would chain
   * invocations to each other and fragment the run view on async queues.
   */
  nextTraceCarrier?: () => Promise<Record<string, string>>;
}): Promise<{ timeoutSeconds?: number } | void> {
  const {
    workflowCode,
    workflowName,
    workflowRun,
    preloadedEvents,
    runInput,
    parentSpan,
    maxEventsLimit,
    namespace,
  } = params;
  // Standalone-caller fallback (tests): without a runtime.ts carrier
  // accessor, fall back to the current invocation context.
  const nextTraceCarrier =
    params.nextTraceCarrier ?? (() => serializeTraceCarrier());
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
  // Resolve the FULL capability (symmetric AES key + X25519 keypair), not
  // just `importKey(rawKey)`: a run reading its own event log can encounter
  // sealed (`encp`) hook payloads that a cross-deployment `resumeHook()`
  // wrote to it (sealing is presence-gated on the run's published
  // encryptionPublicKey, which the shared start() path stamps regardless of
  // engine). A bare symmetric key cannot open those and would wedge the run
  // right after hook_received — the node:vm engine resolves the same full
  // capability via memoizeEncryptionKey.
  const rawKey = await world.getEncryptionKeyForRun?.(workflowRun);
  const encryptionKey = rawKey ? await deriveRunPayloadKeys(rawKey) : undefined;

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

  // Event-limit guard: fail a runaway run once its log reaches the
  // server-supplied ceiling — same enforcement point as the node:vm
  // engine's replay loop.
  if (maxEventsLimit !== undefined && events.length >= maxEventsLimit) {
    throw new MaxEventsExceededError(events.length, maxEventsLimit);
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
    // Fail closed on Hook retention when the World doesn't declare support,
    // matching the node:vm engine's world-capability gate (see hook.ts).
    worldSupportsHookRetention:
      world.capabilities?.hookRetention?.active === true,
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

    // Flush leftover pending side effects (abort recordings, system-hook
    // disposals, fire-and-forget attribute/hook events) BEFORE writing
    // run_completed — mirrors the node:vm engine's drainPendingQueueItems.
    // Drain failures are swallowed: the workflow's own outcome is the
    // source of truth.
    if (result.completed.drainOperations?.length) {
      // Fail loud on retained hooks the World can't support BEFORE the
      // drain try/catch below — that catch intentionally swallows genuine
      // drain failures ("the workflow's own outcome is the source of
      // truth"), but the retention gate's FatalError must escape to the
      // replay loop's catch (run_failed), mirroring the node engine. This
      // covers the fire-and-forget case: a retained hook that was never
      // awaited only reaches the gate through this drain.
      assertHookRetentionSupported(
        result.completed.drainOperations,
        world.capabilities
      );
      try {
        await dispatchPendingOps({
          world,
          runId,
          workflowRun,
          encryptionKey,
          namespace,
          nextTraceCarrier,
          pendingOperations: result.completed.drainOperations,
          queueSteps: false,
          wfdiag,
        });
      } catch (err) {
        runtimeLogger.warn('QuickJS runtime: terminal drain failed', {
          workflowRunId: runId,
          message: (err as Error)?.message,
        });
      }
    }

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
    let soonestWait: { seconds: number; correlationId: string } | undefined;
    const { createdAttributeEvent, createdGetConflictHook } =
      await dispatchPendingOps({
        world,
        runId,
        workflowRun,
        encryptionKey,
        namespace,
        nextTraceCarrier,
        pendingOperations,
        queueSteps: true,
        wfdiag,
      });

    // Handle pending waits — both newly created and still-pending from
    // earlier invocations. For each wait, either create a wait_completed
    // event (if elapsed) or track the soonest pending wait so a delayed
    // continuation can be enqueued below.
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
        // Wait hasn't elapsed yet — track the soonest one.
        const timeoutSeconds = Math.max(1, Math.ceil(resumeMs / 1000));
        if (!soonestWait || timeoutSeconds < soonestWait.seconds) {
          soonestWait = {
            seconds: timeoutSeconds,
            correlationId: wait.correlationId,
          };
        }
      }
    }
    if (waitCompletePromises.length > 0) {
      await Promise.all(waitCompletePromises);
    }

    // Progress and wait continuations are enqueued as FRESH messages
    // rather than returned as `{ timeoutSeconds }` visibility-redelivery
    // of the current message (which is what the node engine's suspension
    // handler does too — see the wait-continuation dispatch in
    // runtime.ts). Redelivering the CURRENT message is a trap: a
    // hook-resume delivery carries `hookInput`, and its redelivery
    // re-runs the lazy-resume re-ensure in the handler prologue. If the
    // workflow disposed that hook during this invocation (dispose →
    // sleep), the re-ensure gets HookNotFound, the prologue acks the
    // message as "nothing left to resume", and the wait timer it was
    // carrying is silently lost — the run wedges. A fresh continuation
    // message carries only `runId`, so its delivery always reaches
    // replay.
    if (needsRequeue || createdAttributeEvent || createdGetConflictHook) {
      // An elapsed wait was completed, a new attr_set event was written,
      // or a getConflict()-awaited hook was created — re-queue immediately
      // so the next invocation can process the new event.
      wfdiag('exit_suspended', {
        action: needsRequeue
          ? 'wait_elapsed_requeue'
          : createdAttributeEvent
            ? 'attr_set_requeue'
            : 'get_conflict_requeue',
        timeoutSeconds: 0,
      });
      await queueMessage(
        world,
        getWorkflowQueueName(workflowRun.workflowName, namespace),
        {
          runId,
          traceCarrier: await nextTraceCarrier(),
          requestedAt: new Date(),
        }
      );
      return;
    }

    if (soonestWait) {
      // Delayed continuation for the soonest pending wait. The dispatch
      // helper handles delay clamping (long waits chain across hops) and
      // idempotency-key dedup of re-observations of the same pending
      // wait — see runtime/wait-continuation.ts.
      wfdiag('exit_suspended', {
        action: 'schedule_wait_timeout',
        timeoutSeconds: soonestWait.seconds,
        waitCorrelationId: soonestWait.correlationId,
      });
      await queueMessage(
        world,
        getWorkflowQueueName(workflowRun.workflowName, namespace),
        {
          runId,
          traceCarrier: await nextTraceCarrier(),
          requestedAt: new Date(),
        },
        getWaitContinuationDispatch(
          soonestWait.seconds,
          soonestWait.correlationId
        )
      );
      return;
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

    // Flush leftover pending side effects before writing run_failed —
    // same drain semantics as the completed branch.
    if (result.failed.drainOperations?.length) {
      // Fail loud on retained hooks the World can't support BEFORE the
      // drain try/catch below — same reasoning as the completed branch:
      // the retention gate's FatalError must escape to the replay loop's
      // catch rather than be swallowed as a genuine drain failure.
      assertHookRetentionSupported(
        result.failed.drainOperations,
        world.capabilities
      );
      try {
        await dispatchPendingOps({
          world,
          runId,
          workflowRun,
          encryptionKey,
          namespace,
          nextTraceCarrier,
          pendingOperations: result.failed.drainOperations,
          queueSteps: false,
          wfdiag,
        });
      } catch (err) {
        runtimeLogger.warn('QuickJS runtime: terminal drain failed', {
          workflowRunId: runId,
          message: (err as Error)?.message,
        });
      }
    }

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
