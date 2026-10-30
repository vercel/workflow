/**
 * The QuickJS deliveries' dispatch of pending VM operations, shared by both
 * orchestrators (`spec8/quickjs-entrypoint.ts`, `spec9/quickjs-entrypoint.ts`).
 * The options that differ between them say which orchestrator uses which.
 */
/**
 * QuickJS WebAssembly (WASM) VM integration with the Workflow DevKit.
 *
 * This module provides the entry point for running workflows in the
 * QuickJS VM engine instead of the `node:vm` engine. Both engines
 * implement the same event-replay execution model, where every invocation:
 *
 * 1. Loads the full event log for the run
 * 2. Runs the workflow function from the top in a fresh QuickJS VM,
 *    replaying the event log to resolve awaited primitives
 * 3. On suspension: creates events + queues steps for new pending ops
 * 4. On completion: creates run_completed
 * 5. On failure: creates run_failed
 */

import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  ThrottleError,
  WorkflowWorldError,
} from '@workflow/errors';

import {
  type CreateEventRequest,
  type EventBatchResult,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  type WorkflowRun,
} from '@workflow/world';

import { runtimeLogger } from './../logger.js';
import { frameAbortStreamPayload } from '../serialization/abort-stream.js';

import {
  encrypt as encryptSerializedData,
  type RunPayloadKeys,
} from './../serialization/encryption.js';
import {
  dehydrateStepArguments,
  dehydrateStepError,
} from './../serialization.js';

import { getWorkflowQueueName, queueMessage } from './helpers.js';
import { publishForceClaimVictimWake } from './hook-wake.js';

import type { EventCreator } from './quickjs-delivery-shared.js';
import { QuickJSLogView } from './quickjs-log-view.js';
import type {
  PendingAttribute,
  PendingHook,
  PendingHookDispose,
  PendingOperation,
  PendingStep,
  PendingWait,
} from './quickjs-runtime.js';

import { batchChunks } from './spec9/step-wait-creation.js';
import { unserializableStepInputPlaceholder } from './unserializable-step.js';

import type { getWorld } from './world.js';

/**
 * Dispatch durable side effects for a set of pending VM operations:
 * step_created (+ optional queueing), hook_created / hook_received (aborts),
 * attr_set, hook_disposed, and wait_created events.
 *
 * Steps are created but never queued here: queueing (or inline execution)
 * is the caller's decision. Used both for suspension
 * processing (the inline loop) and for the terminal drain (flushing
 * leftover side effects when the workflow completed or failed, mirroring
 * the node:vm engine's drainPendingQueueItems).
 */
export async function dispatchPendingOps(params: {
  world: Awaited<ReturnType<typeof getWorld>>;
  runId: string;
  /**
   * The seam every event write in this pass goes through. The inline loop
   * passes a create that names the log position this invocation holds
   * (`eventCount`) and queues what the World hands back for the live VM; see
   * {@link QuickJSLogView}. The terminal drain passes a plain create, since
   * the run is ending and nothing reads its log afterwards.
   */
  createEvent: EventCreator;
  /**
   * The cursor this invocation's log was read to, when the caller wants a lone
   * `hook_created` to ask for the inline delta against it (`sinceCursor`).
   * The hook's awaiters are settled by the event that write commits and by
   * nothing else (a `hook_created`, or the `hook_conflict` a claimed token
   * commits instead), so the delta hands the VM that event, plus anything
   * another writer landed meanwhile, without a listing. Same gate as the node
   * engine's `hookDeltaCursor`: asked for only when exactly one hook needs
   * creating, since two creates diffing against one cursor would produce two
   * deltas of which only the first could be taken. Omitted by the terminal
   * drain.
   */
  deltaCursor?: string;
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
   * Correlation ids of the waits and attribute writes whose event this
   * invocation already committed. Neither has a row a World could refuse a
   * second create with, and the VM may not have been fed the committed event
   * yet (a write's own event is delivered off its response only for
   * `wait_completed`; see `QuickJSLogView.absorb`), so it still reports the
   * op as uncreated. Updated here with every create this dispatch commits.
   */
  writtenOpIds?: Set<string>;
  /** Queue message id of this delivery, recorded on step and wait creates. */
  creatorMessageId?: string;
  /** Queue namespace for all message publishes (see runtime.ts). */
  namespace: string | undefined;
  /**
   * Run-origin trace carrier accessor from runtime.ts. In the default
   * `linked` trace mode this returns the carrier of the run's ORIGIN
   * context (workflow.start), so every invocation links back to the
   * start in a star. Capturing the current context here instead would
   * chain invocations to each other and fragment the run view on async
   * queues.
   */
  nextTraceCarrier: () => Promise<Record<string, string>>;
  /**
   * When true (the inline loop), a step carrying `serializationError` is
   * finalized as step_created (placeholder input) + step_failed so the
   * live-VM feed rejects the step's promise and workflow code can catch
   * it, mirroring the node:vm engine's finalizeUnserializableStep. When
   * false (the terminal drain), such steps are skipped entirely: the run
   * is already completing/failing, no replay follows the drain to observe
   * the failure, and a completed run carrying a failed step would read as
   * a bug from the dashboard, matching the node:vm drain's behavior.
   */
  finalizeUnserializableSteps?: boolean;
  /** The spec version the dispatch's events are stamped with. */
  eventSpecVersion: number;
  /**
   * Whether a creation records its execution mode and run (`inline`,
   * `workflowName`, `attempt` on a placeholder's `step_failed`), as a spec 9
   * run's log does. The spec 8 orchestrator writes main's shapes.
   */
  stampCreations: boolean;
  /**
   * Whether a hook create that committed a `hook_conflict` re-enqueues the
   * run, so a fresh invocation consumes the conflict (the spec 8
   * orchestrator). The spec 9 orchestrator feeds it to the live VM instead,
   * and reports it in `createdHookConflict`.
   */
  requeueOnHookConflict?: boolean;
  /**
   * Writes the pass's `step_created` and `wait_created` events as creation
   * batches rather than one write each (the spec 9 orchestrator, on a World
   * with `createBatch`). See {@link CreationBatches}.
   */
  creationBatches?: CreationBatches;
  wfdiag: (checkpoint: string, fields: Record<string, unknown>) => void;
}): Promise<{
  createdAttributeEvent: boolean;
  createdGetConflictHook: boolean;
  /**
   * A hook create committed a `hook_conflict` instead of a `hook_created`.
   * The workflow consumes it on its next pass: the caller wakes the run if
   * the delivery could end before that.
   */
  createdHookConflict: boolean;
  /**
   * Step cids finalized as failed because their input refused to
   * serialize (see `finalizeUnserializableSteps`). No execution message
   * exists for these; the caller must ensure the run observes the
   * terminal event (the inline loop's feed, or the requeue signal).
   */
  failedSerializationStepCids: Set<string>;
  /** Event ids of the `step_created` events this dispatch wrote. */
  createdStepEventIds: Map<string, string>;
  /** `createdAt` of the `step_created` events this dispatch wrote. */
  createdStepCreatedAts: Map<string, Date>;
  /** Serialized inputs of the steps this dispatch created. */
  createdStepInputs: Map<string, Uint8Array>;
  /**
   * Steps whose creation committed in a creation batch and that were handed
   * to {@link CreationBatches.onStepsCreated}.
   */
  reportedStepCids: Set<string>;
}> {
  const {
    world,
    runId,
    workflowRun,
    encryptionKey,
    pendingOperations,
    createEvent,
  } = params;
  const skipStepCreation = params.skipStepCreation;
  const createdStepEventIds = new Map<string, string>();
  const createdStepCreatedAts = new Map<string, Date>();
  const createdStepInputs = new Map<string, Uint8Array>();
  const creatorMessageId = params.creatorMessageId;
  const wfdiag = params.wfdiag;
  // Step cids finalized as step_created + step_failed because their input
  // refused to serialize. See the `finalizeUnserializableSteps` param.
  const failedSerializationStepCids = new Set<string>();
  // Set when a hook with a parked getConflict() awaiter had its
  // hook_created written this invocation. The workflow must be re-invoked
  // so replay can confirm creation and resolve the awaiter.
  let createdGetConflictHook = false;
  // Set when a hook create committed a `hook_conflict` this invocation.
  let createdHookConflict = false;
  // Set when a new attr_set event is written this invocation. The
  // workflow must be re-invoked to consume it (resolving the pending
  // setAttributes() promise), so the entrypoint requeues immediately,
  // same pattern as an elapsed wait.
  let createdAttributeEvent = false;
  const opsPromises: Promise<void>[] = [];
  const hooksNeedingCreation = pendingOperations.filter(
    (op) => op.type === 'hook' && !op.hasCreatedEvent
  ).length;
  const hookDeltaCursor =
    hooksNeedingCreation === 1 ? params.deltaCursor : undefined;

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
      // side before writing, which matches the node:vm engine's
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
        const result = await createEvent(
          {
            eventType: 'hook_created',
            specVersion: params.eventSpecVersion,
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
              ...(hook.force ? { force: true } : {}),
            } as any,
          },
          hookDeltaCursor !== undefined
            ? { sinceCursor: hookDeltaCursor }
            : undefined
        );

        // A forced creation that took the token over: wake the run it was
        // taken from so its replay reads the hook_disposed the World
        // journaled there. Same contract as the node:vm suspension handler;
        // see `publishForceClaimVictimWake`.
        if (result.hook?.claimedFrom) {
          const outcome = await publishForceClaimVictimWake(
            world,
            runId,
            result.hook
          );
          runtimeLogger.info('Hook token force-claimed from another run', {
            workflowRunId: runId,
            hookId: hook.correlationId,
            victimRunId: result.hook.claimedFrom.runId,
            victimWake: outcome,
          });
        }

        // A token conflict with another run's hook committed a
        // `hook_conflict`, which the workflow has to consume. The inline
        // loop feeds it to the live VM; the caller wakes the run only if
        // the delivery ends before that (see `createdHookConflict`).
        if (result.event?.eventType === 'hook_conflict') {
          createdHookConflict = true;
          if (params.requeueOnHookConflict) {
            await queueMessage(
              world,
              getWorkflowQueueName(workflowRun.workflowName, params.namespace),
              {
                runId,
                traceCarrier: await params.nextTraceCarrier(),
                requestedAt: new Date(),
              },
              {
                // A run row with no recorded version is a legacy run, as on
                // every other spec 8 QuickJS send.
                specVersion: workflowRun.specVersion ?? SPEC_VERSION_LEGACY,
                idempotencyKey: `hook_conflict_${hook.correlationId}`,
              }
            );
          }
        }
      } catch (err) {
        // Already created by a concurrent invocation, so fall through
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
        await createEvent({
          eventType: 'hook_received',
          specVersion: params.eventSpecVersion,
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
          await world.streams.write(
            runId,
            streamName,
            frameAbortStreamPayload(abortPayload)
          );
          await world.streams.close(runId, streamName);
        } catch {
          // Best-effort: the hook event provides the durable
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
      await createEvent({
        eventType: 'hook_disposed',
        specVersion: params.eventSpecVersion,
        correlationId: op.correlationId,
        // The hook's token, which the node:vm engine has always sent. A world
        // that keys a hook's token claim separately from the hook itself needs
        // it to release both, and the only alternative is for it to look the
        // token up first. Omitted rather than sent as undefined when the op
        // carries none, so a world that reads it cannot tell the difference
        // between this engine and a client too old to send one.
        ...(op.token === undefined ? {} : { eventData: { token: op.token } }),
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
  // validated by the world: parallel dispatch would otherwise record a
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
      // Per-op fallback group when the token is unknown: no ordering
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
  const runHookGroup = async (
    group: (PendingHook | PendingHookDispose)[]
  ): Promise<void> => {
    for (const op of group) {
      if (op.type === 'hook') {
        await processHookOp(op);
      } else {
        await processHookDisposeOp(op);
      }
    }
  };
  // Token groups run in parallel with every other op, forced creations
  // included. A forced creation publishes its victim's wake before its group's
  // next write, but nothing else waits for it, and nothing needs to: a crash
  // before the wake is repaid by the next replay from the forced
  // `hook_created` itself, which `forcedCreationsOwingWake` finds wherever it
  // sits in the log, so no row written after it can hide the debt.
  const hookGroups: Promise<void>[] = [];
  for (const group of hookOpsByToken.values()) {
    const running = runHookGroup(group);
    hookGroups.push(running);
    opsPromises.push(running);
  }

  const stepCreatedEvent = (
    step: PendingStep,
    input: Uint8Array | unknown
  ): CreateEventRequest => ({
    eventType: 'step_created',
    specVersion: params.eventSpecVersion,
    correlationId: step.correlationId,
    eventData: {
      stepName: step.stepId,
      input: input as Uint8Array,
      ...(params.stampCreations && {
        workflowName: workflowRun.workflowName,
        inline: false,
      }),
      ...(creatorMessageId ? { creatorMessageId } : {}),
    },
  });
  const waitCreatedEvent = (wait: PendingWait): CreateEventRequest => ({
    eventType: 'wait_created',
    specVersion: params.eventSpecVersion,
    correlationId: wait.correlationId,
    eventData: {
      resumeAt: new Date(wait.resumeAt),
      ...(creatorMessageId ? { creatorMessageId } : {}),
    },
  });

  // The pass's step and wait creations, when they go out as creation
  // batches: more than one of them, and no attribute write in the pass. A
  // World orders an attribute write against the steps of its pass only when
  // they are single writes (see `Storage.events.createBatch`), as the node
  // engine never batches a suspension that carries one. A lone creation
  // stays a single write, as on the node engine.
  const createsStep = (op: PendingOperation): boolean =>
    op.type === 'step' &&
    !op.hasCreatedEvent &&
    !skipStepCreation?.has(op.correlationId);
  const createsWait = (op: PendingOperation): boolean =>
    op.type === 'wait' &&
    !op.hasCreatedEvent &&
    !params.writtenOpIds?.has(op.correlationId);
  const batches =
    params.creationBatches &&
    !pendingOperations.some(
      (op) =>
        op.type === 'attribute' &&
        !op.hasCreatedEvent &&
        !params.writtenOpIds?.has(op.correlationId)
    ) &&
    pendingOperations.filter(
      (op) =>
        createsWait(op) ||
        (createsStep(op) && !(op as PendingStep).serializationError)
    ).length > 1
      ? params.creationBatches
      : undefined;
  const batchedCreations: Promise<BatchedCreation>[] = [];
  const reportedStepCids = new Set<string>();

  for (const op of pendingOperations) {
    if (batches && createsStep(op) && !(op as PendingStep).serializationError) {
      const step = op as PendingStep;
      batchedCreations.push(
        encryptSerializedData(step.input, encryptionKey).then((input) => ({
          event: stepCreatedEvent(step, input),
          step,
          input,
        }))
      );
    } else if (batches && createsWait(op)) {
      params.writtenOpIds?.add(op.correlationId);
      batchedCreations.push(
        Promise.resolve({ event: waitCreatedEvent(op as PendingWait) })
      );
    } else if (createsStep(op)) {
      const step = op as PendingStep;
      opsPromises.push(
        (async () => {
          // The step's input refused to serialize while dumping the VM's
          // pending ops (see PendingStep.serializationError). Finalize it
          // as step_created (placeholder input, since the world requires the
          // step entity before a terminal event) + step_failed carrying
          // the SerializationError, so the live-VM feed rejects the
          // step's promise and workflow code can catch it. Never queue an
          // execution message for it. Mirrors the node:vm engine's
          // finalizeUnserializableStep. In the terminal drain
          // (finalizeUnserializableSteps unset), skip entirely: see the
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
              await createEvent({
                eventType: 'step_created',
                specVersion: params.eventSpecVersion,
                correlationId: step.correlationId,
                eventData: {
                  stepName: step.stepId,
                  // Inline, created by this delivery: if the step_failed
                  // below never lands, the redelivery runs the step inline,
                  // and the executor fails it from the placeholder input.
                  ...(params.stampCreations && {
                    workflowName: workflowRun.workflowName,
                    inline: true,
                  }),
                  ...(creatorMessageId ? { creatorMessageId } : {}),
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
              await createEvent({
                eventType: 'step_failed',
                specVersion: params.eventSpecVersion,
                correlationId: step.correlationId,
                eventData: {
                  stepName: step.stepId,
                  // Never started: this is the step's first and only attempt.
                  ...(params.stampCreations && { attempt: 1 }),
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
          // on the host side, matching what
          // `dehydrateStepArguments` does in the node:vm engine.
          const encryptedInput = await encryptSerializedData(
            step.input,
            encryptionKey
          );

          try {
            const created = await createEvent(
              stepCreatedEvent(step, encryptedInput)
            );
            if (created.event) {
              createdStepEventIds.set(
                step.correlationId,
                created.event.eventId
              );
              createdStepCreatedAts.set(
                step.correlationId,
                new Date(created.event.createdAt)
              );
            }
            if (encryptedInput instanceof Uint8Array) {
              createdStepInputs.set(step.correlationId, encryptedInput);
            }
          } catch (err) {
            if (EntityConflictError.is(err)) return;
            throw err;
          }

          // NOTE: step queueing is otherwise the caller's decision: the
          // inline loop executes fresh steps in the live VM and only
          // queues the overflow / retry / backstop cases (see
          // queueStepMessage).
        })()
      );
    } else if (
      op.type === 'attribute' &&
      !op.hasCreatedEvent &&
      !params.writtenOpIds?.has(op.correlationId)
    ) {
      const attr = op as PendingAttribute;
      params.writtenOpIds?.add(op.correlationId);
      opsPromises.push(
        (async () => {
          try {
            await createEvent({
              eventType: 'attr_set',
              specVersion: params.eventSpecVersion,
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
              // Event already exists (concurrent invocation), but the
              // replay still needs to consume it, so requeue.
              createdAttributeEvent = true;
              return;
            }
            throw err;
          }
        })()
      );
    } else if (
      op.type === 'wait' &&
      !op.hasCreatedEvent &&
      !params.writtenOpIds?.has(op.correlationId)
    ) {
      const wait = op as PendingWait;
      params.writtenOpIds?.add(op.correlationId);
      opsPromises.push(
        (async () => {
          try {
            await createEvent(waitCreatedEvent(wait));
          } catch (err) {
            if (EntityConflictError.is(err)) return;
            throw err;
          }
        })()
      );
    }
  }

  if (batches && batchedCreations.length > 0) {
    opsPromises.push(
      (async () => {
        const creations = await Promise.all(batchedCreations);
        await commitCreationBatches({
          runId,
          batches,
          creations,
          // A step message goes out only once every hook write of the pass
          // settled, as it does when each creation is a single write.
          hooksSettled: Promise.allSettled(hookGroups).then(() => {}),
          onStepCreated: (step, eventId, createdAt, input) => {
            createdStepEventIds.set(step.correlationId, eventId);
            createdStepCreatedAts.set(step.correlationId, createdAt);
            if (input instanceof Uint8Array) {
              createdStepInputs.set(step.correlationId, input);
            }
            reportedStepCids.add(step.correlationId);
          },
        });
      })()
    );
  }

  // Per-op dispatch runs in parallel.
  await Promise.all(opsPromises);

  return {
    createdAttributeEvent,
    createdGetConflictHook,
    createdHookConflict,
    failedSerializationStepCids,
    createdStepEventIds,
    createdStepCreatedAts,
    createdStepInputs,
    reportedStepCids,
  };
}

/**
 * How {@link dispatchPendingOps} writes a pass's step and wait creations as
 * creation batches.
 */
export interface CreationBatches {
  /**
   * Sends one creation batch through the orchestrator's in-band writer and
   * folds what it committed into the log view. A whole-batch failure
   * rejects.
   */
  write(events: CreateEventRequest[]): Promise<EventBatchResult>;
  /**
   * Called once per committed batch with the steps it created, as soon as
   * it committed: the caller sends their step messages while the batches
   * behind it go out. Never called for a step whose creation did not commit.
   */
  onStepsCreated(steps: CreatedBatchStep[]): Promise<void>;
}

/** A step a creation batch created. */
export interface CreatedBatchStep {
  step: PendingStep;
  /** The committed `step_created`'s event id. */
  eventId: string;
  /** The committed `step_created`'s `createdAt`. */
  createdAt: Date;
  /** The step's serialized (possibly encrypted) input. */
  input: Uint8Array | undefined;
}

interface BatchedCreation {
  event: CreateEventRequest;
  /** The step a `step_created` creates. Absent on a `wait_created`. */
  step?: PendingStep;
  input?: unknown;
}

/**
 * Writes a pass's creations in the batches the node engine writes a
 * suspension's (`batchChunks`): up to `MAX_IN_BAND_CREATION_BATCH_EVENTS`
 * events and `MAX_IN_BAND_CREATION_BATCH_BYTES` bytes each, one after
 * another, in order. Each batch's steps are reported as soon as it
 * committed, while the next batch goes out.
 *
 * A batch item answered 409 already exists, as a single write's
 * `EntityConflictError` says: it is skipped, and its step is not reported,
 * so the caller handles it as it handles a conflicted single write's.
 * Any other item refusal fails the pass with the error a single write of
 * that status throws (429 a `ThrottleError`, 410 a `RunExpiredError`, else a
 * `WorkflowWorldError`), and the batches behind it are not sent.
 *
 * The node engine's batches (`writeAll` in `spec9/step-wait-creation.ts`)
 * fail the pass only on a 429 or a 5xx, and leave any other refused item to
 * the next replay, which derives it again. The difference is deliberate: this
 * engine's caller sends a message for every step past the inline cap that no
 * batch reported (`dispatched.reportedStepCids`), since it cannot tell a
 * step whose creation a batch refused from one created by a single write, so
 * a refused step creation that the pass went on past would get a message
 * with no `step_created` behind it. The node engine sends a message only for
 * a creation it saw committed. Transient refusals end the same way on both:
 * the delivery fails and the queue redelivers it. A spec 9
 * batch is not atomic, so the items around a refusal may have committed:
 * the redelivery re-derives the missing creations and re-sends the steps
 * that never got a message (`stepsToReenqueue`). The
 * reports already made settle before the pass fails. A report waits for the
 * pass's hook writes to settle.
 */
async function commitCreationBatches(params: {
  runId: string;
  batches: CreationBatches;
  creations: BatchedCreation[];
  hooksSettled: Promise<void>;
  onStepCreated: (
    step: PendingStep,
    eventId: string,
    createdAt: Date,
    input: unknown
  ) => void;
}): Promise<void> {
  const { batches, creations } = params;
  const reports: Promise<void>[] = [];
  let failure: { error: unknown } | undefined;
  let offset = 0;
  for (const chunk of batchChunks(creations.map((c) => c.event))) {
    const members = creations.slice(offset, offset + chunk.length);
    offset += chunk.length;
    let result: EventBatchResult;
    try {
      result = await batches.write(chunk);
    } catch (error) {
      failure = { error };
      break;
    }
    const created: CreatedBatchStep[] = [];
    result.results.forEach((item, index) => {
      const member = members[index];
      if (!member) return;
      if (item.error === undefined) {
        if (member.step) {
          const createdAt = new Date(item.event.createdAt);
          params.onStepCreated(
            member.step,
            item.event.eventId,
            createdAt,
            member.input
          );
          created.push({
            step: member.step,
            eventId: item.event.eventId,
            createdAt,
            input:
              member.input instanceof Uint8Array ? member.input : undefined,
          });
        }
        return;
      }
      if (item.status === 409 || failure) return;
      runtimeLogger.warn('QuickJS runtime: creation batch item refused', {
        workflowRunId: params.runId,
        eventType: member.event.eventType,
        correlationId: (member.event as { correlationId?: string })
          .correlationId,
        status: item.status,
        error: item.error,
      });
      const message = `Creation batch item failed with ${item.status}: ${item.message}`;
      failure = {
        error:
          item.status === 429
            ? new ThrottleError(message)
            : item.status === 410
              ? new RunExpiredError(message)
              : new WorkflowWorldError(message, { status: item.status }),
      };
    });
    if (created.length > 0) {
      const report = params.hooksSettled.then(() =>
        batches.onStepsCreated(created)
      );
      // Observed as it is stored: a report that rejects while the batches
      // behind it go out is awaited, and its error thrown, only below.
      report.catch(() => {});
      reports.push(report);
    }
    if (failure) break;
  }
  if (failure) {
    await Promise.allSettled(reports);
    throw failure.error;
  }
  await Promise.all(reports);
}
