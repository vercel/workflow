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
  HookNotFoundError,
  MaxEventsExceededError,
  RunExpiredError,
  WorkflowNotRegisteredError,
} from '@workflow/errors';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type Event,
  ROOT_RUN_ID_ATTRIBUTE,
  type RunInput,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  type WorkflowRun,
} from '@workflow/world';
import { classifyRunError, isRetryableWorldError } from '../classify-error.js';
import { runtimeLogger } from '../logger.js';
import {
  deriveRunPayloadKeys,
  encrypt as encryptSerializedData,
  type RunPayloadKeys,
} from '../serialization/encryption.js';
import {
  dehydrateRunError,
  dehydrateStepArguments,
  dehydrateStepError,
  hydrateRunError,
  maybeEncrypt,
} from '../serialization.js';
import { remapErrorStack, stripInlineSourceMap } from '../source-map.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { serializeTraceCarrier } from '../telemetry.js';
import {
  getInlineOwnershipLeaseSeconds,
  getMaxInlineSteps,
  isResilientStepDispatchEnabled,
  MAX_RESILIENT_STEP_INPUT_BYTES,
} from './constants.js';
import { getPortLazy } from './get-port-lazy.js';
import {
  getWorkflowQueueName,
  queueMessage,
  stepDispatchIdempotencyKey,
} from './helpers.js';
import {
  dispatchRunCompletedHooks,
  dispatchRunFailedHooks,
} from './lifecycle-hooks.js';
import {
  BASELINE_BUNDLE_FILENAME,
  type PendingAttribute,
  type PendingHook,
  type PendingHookDispose,
  type PendingOperation,
  type PendingStep,
  type PendingWait,
  startQuickJSWorkflow,
} from './quickjs-runtime.js';
import { ReplayBudget } from './replay-budget.js';
import { executeStep, type StepExecutionResult } from './step-executor.js';
import { runStepSingleFlight } from './step-single-flight.js';
import { unserializableStepInputPlaceholder } from './unserializable-step.js';
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
 * Queue a step for background execution via the unified workflow queue
 * (V2 architecture). The combined handler in runtime.ts dispatches
 * messages with `stepId` to executeStep, which works for both VM engines.
 * `delaySeconds` supports retry/throttle backoff.
 */
async function queueStepMessage(params: {
  world: Awaited<ReturnType<typeof getWorld>>;
  runId: string;
  workflowRun: WorkflowRun;
  step: PendingStep;
  delaySeconds?: number;
  /** Queue namespace for the publish (see runtime.ts). */
  namespace: string | undefined;
  /** Run-origin trace carrier accessor (see runWorkflowWithQuickJS). */
  nextTraceCarrier: () => Promise<Record<string, string>>;
  /**
   * Publish purpose, used to bucket the idempotency key. Worlds retire
   * used keys (VQS retention TTL, world-postgres completed-keys cache),
   * so a key shared across purposes silently swallows the second
   * publish — see wait-continuation.ts for the same hazard on wait
   * keys. `dispatch` is the plain background handoff (overflow / crash
   * recovery) and uses the step-identity-scoped dispatch key
   * (stepDispatchIdempotencyKey) so it stays mutually
   * exclusive with the node engine's dispatch of the same step;
   * `backstop:<epoch>` covers delayed crash backstops, scoped to the
   * ownership epoch so a refreshed lease re-arms a NEW backstop instead
   * of being absorbed by the in-flight one; `retry:<n>` covers delayed
   * retry/throttle re-enqueues, scoped to the attempt so each backoff
   * hop is enqueueable.
   */
  purpose: 'dispatch' | `backstop:${string}` | `retry:${number}`;
  /**
   * Resilient step dispatch: the serialized (possibly encrypted) step input
   * to carry on the message as `stepInput`, so the consumer can idempotently
   * re-ensure the `step_created` event if the producer's parallel direct
   * write failed transiently. Only set on `dispatch` publishes that
   * dispatchPendingOps parallelizes with the step_created write.
   */
  stepInput?: Uint8Array;
  wfdiag: (checkpoint: string, fields: Record<string, unknown>) => void;
}): Promise<void> {
  const {
    world,
    runId,
    workflowRun,
    step,
    delaySeconds,
    namespace,
    nextTraceCarrier,
    purpose,
    stepInput,
    wfdiag,
  } = params;
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
      ...(stepInput !== undefined ? { stepInput: { input: stepInput } } : {}),
    },
    {
      // The 'dispatch' key is step-identity-scoped (correlationId + hashed
      // step name) — shared with the node engine's dispatch of the same step
      // so the two stay mutually exclusive, without a revoked resilient
      // message absorbing a reassigned correlation id's legitimate dispatch.
      // See stepDispatchIdempotencyKey.
      idempotencyKey:
        purpose === 'dispatch'
          ? stepDispatchIdempotencyKey(step.correlationId, step.stepId)
          : `${step.correlationId}:${purpose}`,
      ...(delaySeconds && delaySeconds > 0 ? { delaySeconds } : {}),
    }
  );
  wfdiag('step_queued', {
    stepId: step.stepId,
    correlationId: step.correlationId,
    purpose,
    delaySeconds: delaySeconds ?? 0,
    ...(stepInput !== undefined ? { resilient: true } : {}),
  });
}

/**
 * Dispatch durable side effects for a set of pending VM operations:
 * step_created (+ optional queueing), hook_created / hook_received (aborts),
 * attr_set, hook_disposed, and wait_created events.
 *
 * Steps are created but (usually) not queued here — queueing (or inline
 * execution) is the caller's decision. Used both for suspension
 * processing (the inline loop) and for the terminal drain (flushing
 * leftover side effects when the workflow completed or failed, mirroring
 * the node:vm engine's drainPendingQueueItems).
 *
 * The one exception is resilient step dispatch: for step cids named in
 * `queueStepCids` (the caller's overflow steps) that pass the eligibility
 * gates, the step_created write is parallelized with the step's queue
 * publish — the message carries the serialized input (`stepInput`) so the
 * consumer can idempotently re-ensure the event if the direct write failed
 * transiently. Steps queued this way are reported in `queuedStepCids`; the
 * caller queues the rest itself.
 */
async function dispatchPendingOps(params: {
  world: Awaited<ReturnType<typeof getWorld>>;
  runId: string;
  workflowRun: WorkflowRun;
  encryptionKey: RunPayloadKeys | undefined;
  pendingOperations: PendingOperation[];
  /**
   * Step cids whose `step_created` must NOT be written here: the inline
   * loop claims these atomically via a lazy `step_started` (carrying the
   * input), so a concurrent claimant loses with EntityConflictError
   * instead of both invocations bare-starting the same step.
   */
  skipStepCreation?: Set<string>;
  /**
   * Step cids the caller intends to hand to the queue this turn (overflow
   * steps beyond the inline cap). Eligible ones are published here, in
   * parallel with their step_created write (resilient step dispatch), and
   * reported back in `queuedStepCids`.
   */
  queueStepCids?: Set<string>;
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
  /**
   * When true (the inline loop), a step carrying `serializationError` is
   * finalized as step_created (placeholder input) + step_failed so the
   * live-VM feed rejects the step's promise and workflow code can catch
   * it — mirroring the node:vm engine's finalizeUnserializableStep. When
   * false (the terminal drain), such steps are skipped entirely: the run
   * is already completing/failing, no replay follows the drain to observe
   * the failure, and a completed run carrying a failed step would read as
   * a bug from the dashboard — matching the node:vm drain's behavior.
   */
  finalizeUnserializableSteps?: boolean;
  wfdiag: (checkpoint: string, fields: Record<string, unknown>) => void;
}): Promise<{
  createdAttributeEvent: boolean;
  createdGetConflictHook: boolean;
  /** Step cids already published via resilient dispatch — see above. */
  queuedStepCids: Set<string>;
  /**
   * Step cids finalized as failed because their input refused to
   * serialize (see `finalizeUnserializableSteps`). No execution message
   * exists for these; the caller must ensure the run observes the
   * terminal event (the inline loop's feed, or the requeue signal).
   */
  failedSerializationStepCids: Set<string>;
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
  const skipStepCreation = params.skipStepCreation;
  const queueStepCids = params.queueStepCids;
  const wfdiag = params.wfdiag;
  // Step cids published via resilient dispatch below (create + queue in
  // parallel, message carrying `stepInput`). Reported to the caller so it
  // skips them in its own queueing pass.
  const queuedStepCids = new Set<string>();
  // Step cids finalized as step_created + step_failed because their input
  // refused to serialize — see the `finalizeUnserializableSteps` param.
  const failedSerializationStepCids = new Set<string>();
  // Resilient step dispatch eligibility, shared by every step op below (the
  // per-step input-size check is applied inside the op): feature enabled and
  // a binary-safe (CBOR) queue transport for the run.
  //
  // Unlike the node:vm suspension handler's gate (see
  // SuspensionHandlerParams.stepDispatch), there is NO precondition-guard
  // gate here: this engine's step_created writes are unguarded (no snapshot
  // is attached), so a guard-enforcing World can never 412-reject them —
  // the consumer's re-ensure therefore cannot materialize a step the guard
  // rejected. If this engine ever adopts guarded suspension writes, the
  // capability gate from the node:vm handler must be added here too.
  const resilientDispatchEligible =
    queueStepCids !== undefined &&
    queueStepCids.size > 0 &&
    isResilientStepDispatchEnabled() &&
    (workflowRun.specVersion ?? 0) >=
      SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT;
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
  // claim interaction, so token groups run in parallel with each other
  // and with the non-hook ops below.
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
  for (const group of hookOpsByToken.values()) {
    opsPromises.push(
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

  for (const op of pendingOperations) {
    if (
      op.type === 'step' &&
      !op.hasCreatedEvent &&
      !skipStepCreation?.has(op.correlationId)
    ) {
      const step = op as PendingStep;
      opsPromises.push(
        (async () => {
          // The step's input refused to serialize while dumping the VM's
          // pending ops (see PendingStep.serializationError). Finalize it
          // as step_created (placeholder input — the world requires the
          // step entity before a terminal event) + step_failed carrying
          // the SerializationError, so the live-VM feed rejects the
          // step's promise and workflow code can catch it. Never queue an
          // execution message for it. Mirrors the node:vm engine's
          // finalizeUnserializableStep. In the terminal drain
          // (finalizeUnserializableSteps unset), skip entirely — see the
          // param docs.
          if (step.serializationError) {
            if (!params.finalizeUnserializableSteps) {
              return;
            }
            runtimeLogger.warn(
              'Step arguments failed to serialize; failing the step so ' +
                'the workflow can observe the error',
              {
                workflowRunId: runId,
                correlationId: step.correlationId,
                stepName: step.stepId,
                error: step.serializationError.message,
              }
            );
            try {
              await world.events.create(runId, {
                eventType: 'step_created',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: step.correlationId,
                eventData: {
                  stepName: step.stepId,
                  input: (await dehydrateStepArguments(
                    unserializableStepInputPlaceholder(),
                    runId,
                    encryptionKey,
                    globalThis,
                    false,
                    (workflowRun.specVersion ?? 0) >=
                      SPEC_VERSION_SUPPORTS_COMPRESSION
                  )) as Uint8Array,
                },
              });
            } catch (err) {
              // Concurrent invocation hit the same deterministic failure
              // and created it first, or the run already finished.
              if (RunExpiredError.is(err)) return;
              if (!EntityConflictError.is(err)) throw err;
            }
            try {
              await world.events.create(runId, {
                eventType: 'step_failed',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: step.correlationId,
                eventData: {
                  stepName: step.stepId,
                  error: await dehydrateStepError(
                    step.serializationError,
                    runId,
                    encryptionKey,
                    [],
                    globalThis,
                    (workflowRun.specVersion ?? 0) >=
                      SPEC_VERSION_SUPPORTS_COMPRESSION
                  ),
                },
              });
            } catch (err) {
              // Step already terminal or run already finished.
              if (!EntityConflictError.is(err) && !RunExpiredError.is(err)) {
                throw err;
              }
            }
            failedSerializationStepCids.add(step.correlationId);
            wfdiag('step_serialization_failed', {
              stepId: step.stepId,
              correlationId: step.correlationId,
            });
            return;
          }

          // Create step_created event. `step.input` is the
          // format-prefixed devalue bytes ("devl" + devalue) produced
          // by `globalThis[Symbol.for('workflow-serialize')]({args,
          // closureVars, thisVal})` inside the VM. The VM has no
          // access to the CryptoKey, so encryption is applied here
          // on the host side — matching what
          // `dehydrateStepArguments` does in the node:vm engine.
          const encryptedInput = await encryptSerializedData(
            step.input,
            encryptionKey
          );

          // Resilient step dispatch: fire the step_created write and the
          // step's queue publish in parallel — the message carries the
          // same serialized input (`stepInput`) so the consumer can
          // idempotently re-ensure the event if the direct write failed
          // transiently. Mirrors the node:vm suspension handler and the
          // resilient start / resilient hook resume patterns. Only for
          // caller-designated overflow steps with inputs the queue
          // message can safely carry (binary, under the VQS size cap).
          if (
            resilientDispatchEligible &&
            queueStepCids?.has(step.correlationId) &&
            encryptedInput instanceof Uint8Array &&
            encryptedInput.byteLength <= MAX_RESILIENT_STEP_INPUT_BYTES
          ) {
            const [createResult, queueResult] = await Promise.allSettled([
              world.events.create(runId, {
                eventType: 'step_created',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: step.correlationId,
                eventData: {
                  stepName: step.stepId,
                  input: encryptedInput,
                },
              }),
              queueStepMessage({
                world,
                runId,
                workflowRun,
                step,
                namespace,
                nextTraceCarrier,
                purpose: 'dispatch',
                stepInput: encryptedInput,
                wfdiag,
              }),
            ]);
            // Queue failure is always fatal for this dispatch pass:
            // without the message the step would rely on the create
            // alone, and if the create ALSO failed there would be no
            // durable record at all. Propagating redelivers the
            // orchestrator message, which re-creates the (idempotent)
            // step_created and re-dispatches.
            if (queueResult.status === 'rejected') {
              throw queueResult.reason;
            }
            queuedStepCids.add(step.correlationId);
            if (createResult.status === 'rejected') {
              const err = createResult.reason;
              if (EntityConflictError.is(err)) {
                // Concurrent invocation wrote it first — the message is
                // already out; its duplicate publish dedupes on the
                // shared step-identity-scoped idempotency key.
                return;
              }
              if (isRetryableWorldError(err)) {
                // Resilient: the write failed transiently (429 / 5xx /
                // transport) but the step message — carrying the same
                // serialized input — was published, so the consumer
                // idempotently re-ensures the step_created before
                // executing.
                runtimeLogger.warn(
                  'Step creation event write failed, but the step was ' +
                    'dispatched via the queue. The step_created event ' +
                    'will be ensured by the queue consumer.',
                  {
                    workflowRunId: runId,
                    correlationId: step.correlationId,
                    stepName: step.stepId,
                    error: err instanceof Error ? err.message : String(err),
                  }
                );
                wfdiag('step_resilient_dispatch_recovered', {
                  stepId: step.stepId,
                  correlationId: step.correlationId,
                });
                return;
              }
              throw err;
            }
            return;
          }

          try {
            await world.events.create(runId, {
              eventType: 'step_created',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: step.correlationId,
              eventData: {
                stepName: step.stepId,
                input: encryptedInput,
              },
            });
          } catch (err) {
            if (EntityConflictError.is(err)) return;
            throw err;
          }

          // NOTE: step queueing is otherwise the caller's decision — the
          // inline loop executes fresh steps in the live VM and only
          // queues the overflow / retry / backstop cases (see
          // queueStepMessage).
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

  return {
    createdAttributeEvent,
    createdGetConflictHook,
    queuedStepCids,
    failedSerializationStepCids,
  };
}

/**
 * Run a workflow using the QuickJS WASM VM engine.
 *
 * This replaces the `node:vm` replay path (runWorkflow + EventsConsumer)
 * with a QuickJS VM invocation that performs the same full event replay.
 *
 * KNOWN GAP — slot snapshot: unlike the node:vm path, no event write in
 * this file carries {@link CreateEventParams.eventCount}, so a World never
 * learns which events the writer had not seen and never reports them back.
 * The engine currently relies on per-(runId, correlationId) event
 * uniqueness (EntityConflictError dedup) alone. This is a deliberate
 * simplification while the engine is experimental — wiring the snapshot is
 * tracked follow-up work; anyone adding new write paths here should not
 * assume parity with the node engine on this axis.
 */
export async function runWorkflowWithQuickJS(params: {
  workflowCode: string;
  workflowName: string;
  workflowRun: WorkflowRun;
  /**
   * Events returned inline by `events.create('run_started', ...)` or by
   * the lazy hook fast path's `hook_received` preload. When they indicate
   * a first invocation — or when `preloadedEventsComplete` attests they
   * are the complete log — they are used as the event log instead of
   * fetching via `events.list`, matching the node:vm engine's fast path.
   */
  preloadedEvents?: Event[];
  /**
   * True when the caller has validated that `preloadedEvents` is the run's
   * COMPLETE event log (e.g. the lazy hook fast path's hasMore-false
   * replay preload). The first-invocation heuristic below only recognizes
   * run_created/run_started-only preloads, so without this attestation a
   * hook-resume preload would be discarded and refetched.
   */
  preloadedEventsComplete?: boolean;
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
   * Queue delivery attempt of the message driving this invocation (from
   * the queue handler's metadata; 1 = first delivery). Surfaced in
   * diagnostics; crash recovery itself is driven by the ownership-lease
   * decision table in the loop, not by the attempt count.
   */
  deliveryAttempt?: number;
  /**
   * Queue message ID of the delivery driving this invocation, stamped as
   * `ownerMessageId` on inline lazy step claims so wake replays defer to
   * the in-flight body instead of requeueing the step.
   */
  ownerMessageId?: string;
  /** Request ID of the queue invocation, when the queue provides one. */
  requestId?: string;
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
    preloadedEventsComplete,
    runInput,
    parentSpan,
    maxEventsLimit,
    deliveryAttempt,
    ownerMessageId,
    requestId,
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
    deliveryAttempt,
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
  // and save the events.list round-trips; a caller-attested complete
  // preload (lazy hook fast path) is trusted the same way.
  let events: Event[];
  let eventsFetchedPages = 0;
  const usePreloaded =
    (preloadedEventsComplete === true &&
      Array.isArray(preloadedEvents) &&
      preloadedEvents.length > 0) ||
    isFirstInvocation(preloadedEvents);
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

  const session = await startQuickJSWorkflow({
    // Pass the STRIPPED bundle to the VM so the inline source map
    // doesn't end up in the QuickJS heap. The original (unstripped)
    // `workflowCode` is still kept in this host-side scope and is used
    // by `remapErrorStack` on workflow failures below.
    workflowCode: workflowCodeForVM,
    workflowId,
    workflowRun,
    events,
    worldCapabilities: world.capabilities,
    encryptionKey,
    port,
    runInput,
  });
  let result = session.result;

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

  // ---- Inline continuation loop ----
  //
  // While the workflow is suspended, this loop keeps the VM alive and
  // makes as much forward progress as possible within one invocation:
  //
  //   1. Dispatch durable side effects for the suspension's pending ops
  //      (step_created / hook_created / attr_set / wait_created /
  //      hook_received for aborts) and complete elapsed waits.
  //   2. Feed all newly recorded events (attr_set, hook_created, elapsed
  //      wait_completed, terminals written by concurrent invocations, ...)
  //      into the LIVE VM via session.continueWithEvents — resuming
  //      execution exactly where it left off, no fresh-VM re-replay.
  //      Cheap progress is fed BEFORE running step bodies so promise
  //      chains that are not gated on steps (hook.getConflict(),
  //      setAttributes(), racing sleeps) advance first and can surface
  //      additional pending steps for the same inline batch.
  //   3. Once no cheap progress remains, execute up to
  //      getMaxInlineSteps() steps created by THIS invocation inline (no
  //      queue round-trip), in parallel, with the replay budget paused
  //      during step bodies — mirroring the node:vm engine's inline
  //      replay loop. Overflow and retry/throttled steps are queued for
  //      background execution. A delayed wait-continuation message is
  //      enqueued for the soonest pending wait first, so racing timers
  //      fire on time (in a separate invocation) while step bodies block
  //      this one.
  //
  // The loop exits when the workflow settles, no forward progress is
  // possible in-process, the replay budget is exhausted, or the run is
  // gone.
  const seenEventIds = new Set<string>();
  for (const e of events) {
    if (e.eventId) seenEventIds.add(e.eventId);
  }
  // Step cids already executed inline by this invocation.
  const executedStepIds = new Set<string>();
  // Steps for which THIS invocation already sent a queue message.
  const queuedStepIds = new Set<string>();
  // Aborts THIS invocation already recorded (hook_received written) —
  // guards against re-recording when the VM-side flag has not been
  // cleared yet within the same iteration.
  const recordedAbortIds = new Set<string>();
  // Waits for which THIS invocation already completed/scheduled work.
  const completedWaitIds2 = new Set<string>();
  // Inline-ownership state per step correlationId, derived from every
  // event this invocation observes (initial log + every feed) — the
  // quickjs analog of the replay-derived ownership on the node engine's
  // StepInvocationQueueItem (see step-ownership.ts). Latest-wins:
  // events arrive in log order, so a later step_started overwrites the
  // stamp; a step_retrying lapses ownership permanently for the id.
  const stepOwnership = new Map<
    string,
    { owner?: string; startedAtMs?: number; sawRetrying: boolean }
  >();
  const observeEventsForOwnership = (observed: Event[]): void => {
    for (const e of observed) {
      if (e.correlationId === undefined) continue;
      if (e.eventType === 'step_started') {
        const owner =
          'eventData' in e &&
          e.eventData &&
          'ownerMessageId' in e.eventData &&
          typeof e.eventData.ownerMessageId === 'string'
            ? e.eventData.ownerMessageId
            : undefined;
        const prior = stepOwnership.get(e.correlationId);
        stepOwnership.set(e.correlationId, {
          owner,
          startedAtMs: e.createdAt ? +new Date(e.createdAt) : undefined,
          sawRetrying: prior?.sawRetrying ?? false,
        });
      } else if (e.eventType === 'step_retrying') {
        const prior = stepOwnership.get(e.correlationId);
        stepOwnership.set(e.correlationId, {
          ...(prior ?? {}),
          sawRetrying: true,
        });
      }
    }
  };
  observeEventsForOwnership(events);
  const scheduledWaitContinuations = new Set<string>();
  const maxInlineSteps = getMaxInlineSteps();
  const budget = new ReplayBudget();
  const workflowStartedAt = workflowRun.startedAt
    ? +workflowRun.startedAt
    : Date.now();
  const rootRunId =
    (workflowRun.attributes as Record<string, string> | undefined)?.[
      ROOT_RUN_ID_ATTRIBUTE
    ] ?? runId;
  let inlineStepsExecuted = 0;
  let runGone = false;
  // Set when this invocation wrote an event the workflow must consume to
  // make progress (attr_set, getConflict-awaited hook_created) and the
  // loop has not yet read it back — eventually-consistent listings can
  // return 0 new events right after a write. If it is still set when the
  // loop exits suspended, the entrypoint requeues immediately instead of
  // exiting awaiting_external with the unblocking event already written
  // and nothing scheduled to read it.
  let pendingRequeueSignal = false;

  /** Fetch all events not yet processed by the live VM (log order). */
  const fetchUnseenEvents = async (): Promise<Event[]> => {
    const unseen: Event[] = [];
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
      for (const e of response.data) {
        if (e.eventId && seenEventIds.has(e.eventId)) continue;
        if (e.eventId) seenEventIds.add(e.eventId);
        unseen.push(e);
      }
      if (response.cursor) cursor = response.cursor;
      hasMore = response.data.length > 0 && response.cursor != null;
    }
    observeEventsForOwnership(unseen);
    return unseen;
  };

  try {
    let iteration = 0;
    while (result.suspended && !runGone && !budget.isExhausted()) {
      iteration++;
      // Re-check the event ceiling every turn: the loop appends events on
      // each continueWithEvents, so a single invocation can otherwise grow
      // the log arbitrarily far past the operator's limit (the node engine
      // re-checks per replay for the same reason). `seenEventIds` counts
      // every event this invocation has observed — initial log + all
      // feeds.
      if (maxEventsLimit !== undefined && seenEventIds.size >= maxEventsLimit) {
        throw new MaxEventsExceededError(seenEventIds.size, maxEventsLimit);
      }
      const pendingOperations = result.suspended.pendingOperations;

      // Select this turn's inline candidates BEFORE dispatch: fresh steps
      // (no step_created yet) that this invocation hasn't already handled.
      // Their step_created is deliberately NOT written by dispatch — the
      // inline claim below is a lazy step_started carrying the input,
      // which the world applies as an atomic create-claim. A concurrent
      // invocation racing on the same fresh step loses that claim with
      // EntityConflictError and skips, so step bodies cannot double-run
      // (previously both invocations bare-started the step after one lost
      // the swallowed step_created race).
      const freshSteps = pendingOperations.filter(
        (op): op is PendingStep =>
          op.type === 'step' &&
          !op.hasCreatedEvent &&
          !executedStepIds.has(op.correlationId) &&
          !queuedStepIds.has(op.correlationId)
      );
      // Steps whose input refused to serialize (see
      // PendingStep.serializationError) never execute: they must not be
      // inline-claimed (a lazy step_started would need the very input that
      // failed) nor queued. Dispatch below finalizes them as step_created
      // + step_failed instead; only healthy steps compete for inline
      // slots and overflow.
      const healthySteps = freshSteps.filter(
        (step) => !step.serializationError
      );
      const inlineCandidates =
        maxInlineSteps <= 0 ? [] : healthySteps.slice(0, maxInlineSteps);
      const inlineClaimCids = new Set(
        inlineCandidates.map((step) => step.correlationId)
      );

      // 1. Durable side effects for this suspension's pending ops.
      const opsToDispatch = pendingOperations.map((op) =>
        op.type === 'hook' &&
        (op as PendingHook).abortRequested &&
        recordedAbortIds.has(op.correlationId)
          ? ({ ...op, abortRequested: false } as PendingOperation)
          : op
      );
      for (const op of pendingOperations) {
        if (op.type === 'hook' && (op as PendingHook).abortRequested) {
          recordedAbortIds.add(op.correlationId);
        }
      }
      // Steps beyond the inline cap are handed to the queue in the same
      // turn their step_created is written. Where eligible, the dispatch
      // below parallelizes each overflow step's step_created write with
      // its queue publish (resilient step dispatch — the message carries
      // `stepInput` so the consumer can re-ensure the event); the rest
      // are queued right after, in parallel. This must all happen BEFORE
      // the event feed below: the feed always observes those very
      // step_created writes as unseen events and `continue`s, so a
      // handoff placed after it is unreachable on the only iteration
      // that still classifies these steps as fresh — next turn they carry
      // hasCreatedEvent and would never be queued at all (the wedge behind
      // promiseRaceStressTestWorkflow hanging in the quickjs CI legs). The
      // step-identity-scoped idempotency key makes repeats harmless.
      const overflowSteps = healthySteps.slice(inlineCandidates.length);
      const dispatched = await dispatchPendingOps({
        world,
        runId,
        workflowRun,
        encryptionKey,
        namespace,
        nextTraceCarrier,
        pendingOperations: opsToDispatch,
        skipStepCreation: inlineClaimCids,
        queueStepCids: new Set(overflowSteps.map((s) => s.correlationId)),
        finalizeUnserializableSteps: true,
        wfdiag,
      });
      if (
        dispatched.createdAttributeEvent ||
        dispatched.createdGetConflictHook
      ) {
        pendingRequeueSignal = true;
      }
      // A finalized unserializable step has terminal events durably
      // written but no execution message anywhere: if the feed below
      // doesn't surface them (eventually-consistent listing) and the loop
      // exits, nothing would ever re-invoke the run to observe the
      // failure. Raise the requeue signal — same mechanism as inline
      // terminals — and mark the steps handled so later turns don't
      // re-finalize or backstop-queue them.
      if (dispatched.failedSerializationStepCids.size > 0) {
        pendingRequeueSignal = true;
        for (const cid of dispatched.failedSerializationStepCids) {
          executedStepIds.add(cid);
        }
      }

      for (const cid of dispatched.queuedStepCids) {
        queuedStepIds.add(cid);
      }
      await Promise.all(
        overflowSteps
          .filter((step) => !dispatched.queuedStepCids.has(step.correlationId))
          .map((step) => {
            queuedStepIds.add(step.correlationId);
            return queueStepMessage({
              world,
              runId,
              workflowRun,
              step,
              namespace,
              nextTraceCarrier,
              purpose: 'dispatch',
              wfdiag,
            });
          })
      );

      // Complete elapsed waits so their wait_completed events are picked
      // up by the feed below (instead of a queue re-invocation).
      const waitCompletePromises: Promise<void>[] = [];
      for (const op of pendingOperations) {
        if (op.type !== 'wait') continue;
        const wait = op as PendingWait;
        if (completedWaitIds2.has(wait.correlationId)) continue;
        if (new Date(wait.resumeAt).getTime() - Date.now() > 0) continue;
        completedWaitIds2.add(wait.correlationId);
        waitCompletePromises.push(
          (async () => {
            try {
              await world.events.create(runId, {
                eventType: 'wait_completed',
                specVersion: SPEC_VERSION_CURRENT,
                correlationId: wait.correlationId,
              });
            } catch (err) {
              if (EntityConflictError.is(err)) return;
              throw err;
            }
          })()
        );
      }
      if (waitCompletePromises.length > 0) {
        await Promise.all(waitCompletePromises);
      }

      // 2. Cheap progress first: feed newly recorded events into the live
      // VM before blocking on step bodies.
      {
        const newEvents = await fetchUnseenEvents();
        if (newEvents.length > 0) {
          // The listing caught up with this invocation's writes — any
          // attr_set / getConflict hook_created has been (or is being)
          // consumed by the live VM, so no external requeue is needed.
          pendingRequeueSignal = false;
          result = await session.continueWithEvents(newEvents);
          wfdiag('inline_iteration', {
            iteration,
            phase: 'feed',
            fedEvents: newEvents.length,
            outcome: result.completed
              ? 'completed'
              : result.failed
                ? 'failed'
                : 'suspended',
          });
          continue;
        }
      }

      // 3. No cheap progress left — execute steps inline.
      const stepOps = pendingOperations.filter(
        (op): op is PendingStep => op.type === 'step'
      );
      // Steps created by an EARLIER invocation (or an earlier turn) that
      // are still pending, with no work owned by THIS invocation. Mirror
      // the node engine's ownership decision table (step-ownership.ts) —
      // NOT a deliveryAttempt gate: worlds advance the attempt counter on
      // routine redeliveries (world-local counts every handled response),
      // so attempt > 1 is the common case and would fire backstops at
      // steps actively executing inline in a live invocation.
      //
      //   - Ownership lease ACTIVE, held by ANOTHER message → the step is
      //     (presumably) executing inline in a live invocation. Arm a
      //     DELAYED backstop for the lease remainder, keyed to the
      //     ownership epoch (a refreshed lease re-arms a fresh backstop
      //     instead of deduping against the in-flight one). If the owner
      //     completes normally, the backstop delivery resolves the step
      //     as 'skipped'.
      //   - Ownership lease ACTIVE, held by THIS message → this delivery
      //     is the owner's redelivery; the claimant crashed
      //     mid-execution. Dispatch immediately for background recovery.
      //   - No stamp / lease EXPIRED / step_retrying observed → the step
      //     is queue-owned or orphaned. Dispatch immediately; the
      //     step-identity-scoped idempotency key dedupes against the
      //     original handoff.
      const nowMs = Date.now();
      for (const step of stepOps) {
        if (!step.hasCreatedEvent) continue;
        if (executedStepIds.has(step.correlationId)) continue;
        if (queuedStepIds.has(step.correlationId)) continue;
        const ownership = stepOwnership.get(step.correlationId);
        const ownershipActive =
          ownership !== undefined &&
          ownership.owner !== undefined &&
          !ownership.sawRetrying;
        let leaseRemainingSeconds = 0;
        if (ownershipActive && ownership.startedAtMs !== undefined) {
          const leaseSeconds = getInlineOwnershipLeaseSeconds();
          leaseRemainingSeconds = Math.min(
            leaseSeconds,
            Math.max(
              0,
              Math.ceil(
                (ownership.startedAtMs + leaseSeconds * 1000 - nowMs) / 1000
              )
            )
          );
        }
        if (
          ownershipActive &&
          ownership.owner !== ownerMessageId &&
          leaseRemainingSeconds > 0
        ) {
          queuedStepIds.add(step.correlationId);
          await queueStepMessage({
            world,
            runId,
            workflowRun,
            step,
            delaySeconds: leaseRemainingSeconds,
            namespace,
            nextTraceCarrier,
            purpose: `backstop:${ownership.startedAtMs}`,
            wfdiag,
          });
        } else {
          queuedStepIds.add(step.correlationId);
          await queueStepMessage({
            world,
            runId,
            workflowRun,
            step,
            namespace,
            nextTraceCarrier,
            purpose: 'dispatch',
            wfdiag,
          });
        }
      }

      if (inlineCandidates.length === 0) {
        // No in-process progress possible — the run awaits an external
        // stimulus (hook payload, queued step, wait timer).
        break;
      }

      // Racing timers must fire on time while step bodies block this
      // invocation: enqueue a delayed continuation for the soonest
      // pending wait (a separate invocation writes its wait_completed at
      // the right log position — same mechanism as the node:vm engine's
      // wait-continuation dispatch).
      let soonestWait: { correlationId: string; seconds: number } | undefined;
      for (const op of pendingOperations) {
        if (op.type !== 'wait') continue;
        const wait = op as PendingWait;
        if (scheduledWaitContinuations.has(wait.correlationId)) continue;
        // Waits whose wait_completed THIS invocation already wrote (the
        // elapsed-wait pass above) are done — the event just hasn't fed
        // back into the VM yet. No continuation needed.
        if (completedWaitIds2.has(wait.correlationId)) continue;
        const resumeMs = new Date(wait.resumeAt).getTime() - Date.now();
        // An already-elapsed wait MUST still get a continuation (clamped
        // to the 1s minimum, exactly like the node engine's
        // `Math.max(1000, resumeAtMs - now)`), not be skipped: a wait
        // whose deadline falls between this iteration's elapsed-wait
        // pass (which saw it as still pending and wrote nothing) and
        // this sweep would otherwise get NEITHER a wait_completed NOR a
        // continuation — and the inline batch below then blocks this
        // invocation for the full step duration with no wake armed
        // anywhere. For `Promise.race(step, sleep)` that silently hands
        // the race to the step: the sleep's wait_completed is never
        // written and the run completes with the wrong winner. The
        // window between the two checks spans this iteration's dispatch
        // + feed round-trips, so on network-backed worlds (world-vercel)
        // a short sleep lands in it routinely — observed as a ~50%
        // sleepWinsRaceWorkflow failure rate in the Vercel e2e legs,
        // while world-local's sub-ms round-trips masked it locally. The
        // continuation invocation's pre-VM elapsed check writes the
        // wait_completed ~1s later.
        const seconds = Math.max(1, Math.ceil(resumeMs / 1000));
        if (!soonestWait || seconds < soonestWait.seconds) {
          soonestWait = { correlationId: wait.correlationId, seconds };
        }
      }
      if (soonestWait) {
        scheduledWaitContinuations.add(soonestWait.correlationId);
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
        wfdiag('wait_continuation_scheduled', {
          correlationId: soonestWait.correlationId,
          delaySeconds: soonestWait.seconds,
        });
      }

      // Execute the inline batch in parallel. The replay budget is
      // paused while step bodies run — step duration is bounded by the
      // platform function duration, not the replay timeout. NOTE (by
      // design): with the budget parked per batch, the only bound on how
      // many inline steps one invocation can chain is the platform's
      // function timeout — the SDK deliberately imposes no cap of its
      // own, matching the node:vm engine, where a long sequential
      // workflow likewise runs step-by-step until the platform reclaims
      // the invocation and a redelivery resumes from the log.
      budget.pause();
      let outcomes: StepExecutionResult[];
      try {
        outcomes = await Promise.all(
          inlineCandidates.map((step) =>
            runStepSingleFlight(runId, step.correlationId, () =>
              (async () =>
                executeStep({
                  world,
                  workflowRunId: runId,
                  workflowDeploymentId: workflowRun.deploymentId,
                  workflowName: workflowRun.workflowName,
                  workflowStartedAt,
                  requestId,
                  rootRunId,
                  stepId: step.correlationId,
                  stepName: step.stepId,
                  encryptionKey,
                  runSpecVersion: workflowRun.specVersion,
                  // Lazy inline claim: step_created is deferred (dispatch
                  // skipped it) and this step_started carries the input,
                  // so the world creates the step atomically —
                  // exactly-one-owner. A concurrent claimant gets
                  // EntityConflictError → { type: 'skipped' } and never
                  // runs the body. Mirrors the node engine's inline path.
                  lazyStepInput: await encryptSerializedData(
                    step.input,
                    encryptionKey
                  ),
                  // Ownership stamp: wake replays see the body as in
                  // flight in this invocation and arm a delayed backstop
                  // instead of immediately requeueing the step.
                  ownerMessageId,
                  // A lazy step is brand-new by construction — first
                  // attempt.
                  authoritativeAttempt: 1,
                }))()
            )
          )
        );
      } finally {
        budget.resume();
      }
      inlineStepsExecuted += inlineCandidates.length;

      for (let i = 0; i < inlineCandidates.length; i++) {
        const step = inlineCandidates[i];
        const outcome = outcomes[i];
        executedStepIds.add(step.correlationId);
        if (outcome.type === 'retry' || outcome.type === 'throttled') {
          // Hand the step to the queue with the requested backoff —
          // background delivery drives the retry from here.
          queuedStepIds.add(step.correlationId);
          await queueStepMessage({
            world,
            runId,
            workflowRun,
            step,
            delaySeconds: outcome.timeoutSeconds,
            namespace,
            nextTraceCarrier,
            // Suffixed key: this step was inline-claimed, so no dispatch
            // publish exists under the dispatch key — but suffixing
            // keeps the retry enqueueable even if a world retired a
            // historical key for this step (see the purpose docs above).
            purpose: 'retry:1',
            wfdiag,
          });
        } else if (outcome.type === 'gone') {
          runGone = true;
        }
        // 'skipped': a concurrent invocation won the lazy create-claim and
        // owns the body. Marked executed above so this invocation never
        // re-claims it; the winner's terminal events arrive via the feed
        // (or drive a separate invocation).
      }
      wfdiag('inline_steps_executed', {
        iteration,
        count: inlineCandidates.length,
        outcomes: outcomes.map((o) => o.type),
      });

      // Feed the inline batch's terminal events into the live VM. When
      // the eventually-consistent listing has not surfaced them yet,
      // exiting must NOT ack silently: the terminals this invocation just
      // caused are durably written with no queue message left to consume
      // them (inline steps have none), so an awaiting_external exit would
      // park the run 'running' with all its steps complete. Raise the
      // requeue signal so the suspended exit schedules a fresh immediate
      // invocation whose fresh read picks the terminals up. Outcomes that
      // wrote no terminal ('skipped' — a concurrent claimant owns the
      // body; 'gone', retry/throttled — a queue message exists) don't
      // need it, but signaling on them too only costs a no-op invocation
      // in an already-rare lag window.
      const newEvents = await fetchUnseenEvents();
      if (newEvents.length === 0) {
        pendingRequeueSignal = true;
        break;
      }
      result = await session.continueWithEvents(newEvents);

      wfdiag('inline_iteration', {
        iteration,
        phase: 'steps',
        fedEvents: newEvents.length,
        outcome: result.completed
          ? 'completed'
          : result.failed
            ? 'failed'
            : 'suspended',
        budgetExhausted: budget.isExhausted(),
      });
    }
  } finally {
    session.dispose();
  }

  parentSpan?.setAttributes({
    ...Attribute.QuickJSInlineSteps(inlineStepsExecuted),
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
      try {
        await dispatchPendingOps({
          world,
          runId,
          workflowRun,
          encryptionKey,
          namespace,
          nextTraceCarrier,
          pendingOperations: result.completed.drainOperations,
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
      dispatchRunCompletedHooks(runId);
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
    // Workflow still suspended after the inline loop. All durable side
    // effects for the final suspension state were already dispatched by
    // the loop; what remains is deciding how the run gets re-invoked.
    const { pendingOperations } = result.suspended;

    runtimeLogger.info('QuickJS runtime: workflow suspended', {
      workflowRunId: runId,
      inlineStepsExecuted,
      pendingSteps: pendingOperations.filter((p) => p.type === 'step').length,
      pendingWaits: pendingOperations.filter((p) => p.type === 'wait').length,
      pendingOps: pendingOperations.map((p) => ({
        type: p.type,
        correlationId: p.correlationId,
        hasCreatedEvent: p.hasCreatedEvent,
        ...(p.type === 'step' ? { stepId: (p as PendingStep).stepId } : {}),
      })),
    });

    parentSpan?.setAttributes({
      ...Attribute.QuickJSOutcome('suspended'),
      ...Attribute.QuickJSPendingOpsCount(pendingOperations.length),
    });

    if (runGone) {
      // The run no longer exists (expired / deleted) — nothing to drive.
      wfdiag('exit_suspended', { action: 'run_gone' });
      return;
    }

    // Exit requeues are FRESH messages, never a `{ timeoutSeconds }`
    // visibility-redelivery of the current message. Redelivering the
    // CURRENT message is a trap: a hook-resume delivery carries
    // `hookInput`, and its redelivery re-runs the lazy-resume re-ensure
    // in the handler prologue — if the workflow disposed that hook
    // during this invocation (dispose → sleep), a world that rejects
    // the re-ensure would ack the message as "nothing left to resume"
    // and the continuation it carried is silently lost. A fresh message
    // carries only `runId`, so its delivery always reaches replay (and
    // under turbo a reschedule would re-engage turbo against a stale
    // preloaded log — see the reinvoke() docs in runtime.ts).
    const requeueImmediately = async (): Promise<void> => {
      await queueMessage(
        world,
        getWorkflowQueueName(workflowRun.workflowName, namespace),
        {
          runId,
          traceCarrier: await nextTraceCarrier(),
          requestedAt: new Date(),
        }
      );
    };

    if (budget.isExhausted()) {
      // The loop stopped on the replay budget with progress still
      // possible — continue in a fresh invocation.
      wfdiag('exit_suspended', { action: 'budget_exhausted_requeue' });
      await requeueImmediately();
      return;
    }

    // Exit wait sweep. A wait that elapsed in the window since the
    // loop's last check requeues immediately (its wait_completed is
    // written by the next invocation's elapsed-wait pass); pending waits
    // whose continuation the loop already enqueued are skipped.
    let soonestWait: { seconds: number; correlationId: string } | undefined;
    let hasElapsedWait = false;
    for (const op of pendingOperations) {
      if (op.type !== 'wait') continue;
      const wait = op as PendingWait;
      const resumeMs = new Date(wait.resumeAt).getTime() - Date.now();
      if (resumeMs <= 0) {
        hasElapsedWait = true;
      } else if (!scheduledWaitContinuations.has(wait.correlationId)) {
        const timeoutSeconds = Math.max(1, Math.ceil(resumeMs / 1000));
        if (!soonestWait || timeoutSeconds < soonestWait.seconds) {
          soonestWait = {
            seconds: timeoutSeconds,
            correlationId: wait.correlationId,
          };
        }
      }
    }

    if (hasElapsedWait) {
      wfdiag('exit_suspended', { action: 'wait_elapsed_requeue' });
      await requeueImmediately();
      return;
    }

    if (pendingRequeueSignal) {
      // This invocation wrote events the workflow needs to consume
      // (attr_set / getConflict-awaited hook_created / inline step
      // terminals) but the eventually-consistent listing never returned
      // them before the loop exited. Without a requeue the run would
      // park awaiting_external with its unblocking events already
      // durably written and no future invocation coming — requeue
      // immediately so a fresh read picks them up. In the common case
      // the loop's own feed observes the writes and clears this flag, so
      // this only fires when the read actually lagged.
      wfdiag('exit_suspended', { action: 'unread_self_write_requeue' });
      await requeueImmediately();
      return;
    }

    if (soonestWait) {
      // Delayed continuation for the soonest pending wait the loop has
      // not already scheduled. The dispatch helper handles delay
      // clamping (long waits chain across hops) and idempotency-key
      // dedup of re-observations of the same pending wait — see
      // runtime/wait-continuation.ts.
      wfdiag('exit_suspended', {
        action: 'schedule_wait_timeout',
        timeoutSeconds: soonestWait.seconds,
        waitCorrelationId: soonestWait.correlationId,
      });
      scheduledWaitContinuations.add(soonestWait.correlationId);
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
    // Workflow failed — remap stack trace using inline source maps.
    // Frames carry the run's workflowId as their filename on the fresh
    // path, but the workflow-independent BASELINE_BUNDLE_FILENAME on the
    // snapshot path (the name is baked into the shared baseline's
    // compiled code at hydrate) — remap against both. remapErrorStack
    // early-exits on a cheap includes() when a filename has no frames.
    let errorStack = result.failed.stack;
    if (errorStack) {
      const parsedName = parseWorkflowName(workflowName);
      const filename = parsedName?.moduleSpecifier || workflowName;
      errorStack = remapErrorStack(errorStack, filename, workflowCode);
      errorStack = remapErrorStack(
        errorStack,
        BASELINE_BUNDLE_FILENAME,
        workflowCode
      );
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
      try {
        await dispatchPendingOps({
          world,
          runId,
          workflowRun,
          encryptionKey,
          namespace,
          nextTraceCarrier,
          pendingOperations: result.failed.drainOperations,
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
    // The most faithful host-side error value available, handed to the
    // lifecycle onRunFailed hooks after the terminal write lands: the
    // hydrated VM value when the modern path succeeds, otherwise the
    // reconstructed host Error.
    let lifecycleError: unknown = reconstructed;
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
          // Both filename spaces — see the failed-branch comment above.
          (hydrated as { stack?: string }).stack = remapErrorStack(
            remapErrorStack(
              (hydrated as { stack: string }).stack,
              filename,
              workflowCode
            ),
            BASELINE_BUNDLE_FILENAME,
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
            // Both filename spaces — see the failed-branch comment above.
            (node as { stack?: string }).stack = remapErrorStack(
              remapErrorStack(nodeStack, filename, workflowCode),
              BASELINE_BUNDLE_FILENAME,
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
        lifecycleError = hydrated;
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
    dispatchRunFailedHooks(runId, lifecycleError, errorCode);
    wfdiag('exit_failed', { result: 'run_failed_written' });
  }
}
