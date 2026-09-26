import {
  FatalError,
  HookConflictError,
  HookForceClaimedError,
  ReplayDivergenceError,
} from '@workflow/errors';
import { WORKFLOW_DESERIALIZE } from '@workflow/serde';
import {
  type PromiseWithResolvers,
  parseDurationToDate,
  withResolvers,
} from '@workflow/utils';
import type { HookConflictEvent } from '@workflow/world';
import { getSerializationClass, RUN_CLASS_ID } from '../class-serialization.js';
import type { Hook, HookOptions } from '../create-hook.js';
import { EventConsumerResult } from '../events-consumer.js';
import { webhookLogger } from '../logger.js';
import {
  awaitEarlierDeliveries,
  registerDeliveryBarrier,
  scheduleWorkflowSuspension,
  type WorkflowOrchestratorContext,
} from '../private.js';
import type { Run } from '../runtime/run.js';
import { hydrateStepReturnValue } from '../serialization.js';

/**
 * Constructs a `Run` handle for the run that owns a conflicting hook
 * token, for resolution through `hook.getConflict()`.
 *
 * The instance is created through the serialization class registry on
 * the VM's globalThis, the same channel that revives serialized `Run`
 * instances (e.g. `start()` return values crossing from a step into the
 * workflow). The registered class is the VM bundle's plugin-compiled
 * `Run`, whose methods are durable step proxies (safe to call from
 * workflow code), and construction goes through its
 * `WORKFLOW_DESERIALIZE` hook, exactly as the `Instance` reviver would.
 *
 * Returns `null` when a real `Run` cannot be constructed: the conflict
 * event lacks `conflictingRunId` (written by an old world), or the VM's
 * registry has no `Run` (a context that never evaluated the
 * workflow-mode `create-hook` module, which aliases it under
 * `RUN_CLASS_ID`). `getConflict` awaiters then reject with
 * `HookConflictError` instead of resolving with a value that doesn't
 * honor the `Run` contract.
 */
function createConflictingRun(
  ctx: WorkflowOrchestratorContext,
  conflictingRunId: string | undefined
): Run<unknown> | null {
  if (typeof conflictingRunId !== 'string') {
    return null;
  }
  const RunClass = getSerializationClass(RUN_CLASS_ID, ctx.globalThis) as
    | (abstract new (
        ...args: never
      ) => Run<unknown>)
    | undefined;
  const deserialize = (RunClass as any)?.[WORKFLOW_DESERIALIZE];
  if (typeof deserialize !== 'function') {
    return null;
  }
  return deserialize.call(RunClass, { runId: conflictingRunId });
}

export function createCreateHook(ctx: WorkflowOrchestratorContext) {
  return function createHookImpl<T = any>(options: HookOptions = {}): Hook<T> {
    // Reject an explicit empty-string token. A token must either be omitted
    // (or `undefined`/`null`) to get a generated one, or be an
    // explicit non-empty string. An empty string is almost always an
    // accidental value (e.g. an unset variable) and would otherwise slip
    // through the `??` below (which only falls back for nullish values) and
    // be used as a meaningless, non-deterministic token.
    if (options.token === '') {
      throw new Error(
        '`createHook()` was called with an empty string token. Pass a non-empty token, or omit the `token` option to use a generated one.'
      );
    }

    if (
      options.isWebhook === true &&
      options.experimental_minRetention !== undefined
    ) {
      throw new Error(
        'Webhook hooks do not support `experimental_minRetention`. Use a non-webhook `createHook()` with `resumeHook()`.'
      );
    }

    if (
      options.experimental_minRetention !== undefined &&
      ctx.worldCapabilities?.hookRetention?.active !== true
    ) {
      throw new FatalError(
        'The configured World does not support `experimental_minRetention` for Hooks.'
      );
    }

    if (options.experimental_force === true) {
      // A generated token is unique by construction and can never be held by
      // another run, so forcing one is a mistake worth surfacing rather than
      // a no-op worth allowing.
      if (options.token === undefined || options.token === null) {
        throw new Error(
          '`createHook()` was called with `experimental_force: true` but no `token`. Force-claiming only applies to an explicit token another run may hold.'
        );
      }
      if (options.isWebhook === true) {
        throw new Error(
          'Webhook hooks do not support `experimental_force`. Use a non-webhook `createHook()` with an explicit token.'
        );
      }
      if (ctx.worldCapabilities?.hookForceClaim !== true) {
        throw new FatalError(
          'The configured World does not support `experimental_force` for Hooks.'
        );
      }
    }

    // Generate hook ID and token
    const correlationId = `hook_${ctx.generateUlid()}`;
    const token = options.token ?? ctx.generateNanoid();
    const tokenRetentionUntil =
      options.experimental_minRetention === undefined
        ? undefined
        : parseDurationToDate(options.experimental_minRetention);

    // Add hook creation to invocations queue (using Map for O(1) operations)
    const isWebhook = options.isWebhook ?? false;

    ctx.invocationsQueue.set(correlationId, {
      type: 'hook',
      correlationId,
      token,
      tokenRetentionUntil,
      ...(options.experimental_force === true && { force: true }),
      metadata: options.metadata,
      isWebhook,
    });

    // Queue of buffered hook payloads (received before the workflow awaited
    // the hook). Each entry's `claim()` builds the consumer-facing promise
    // from the captured hydration outcome and orders it deterministically by
    // event-log position against any concurrent branch-deciding resolution
    // (see `ctx.pendingDeliveryBarriers`).
    const payloadsQueue: { claim: () => Promise<T> }[] = [];

    // The pending awaiter for the next hook payload. Holds at most one entry:
    // concurrent awaits share it (see `createHookPromise`).
    const promises: PromiseWithResolvers<T>[] = [];

    // The awaiter a consumed `hook_received` payload is on its way to. It
    // leaves `promises` when the event is consumed but only settles after
    // earlier deliveries, so awaits made in between must share it too.
    let inFlight: PromiseWithResolvers<T> | undefined;

    // Queue of promises that resolve once hook registration is confirmed
    // (with `null`) or a token conflict is detected (with the conflicting
    // `Run`). These back the `hook.getConflict()` getter.
    const getConflictPromises: PromiseWithResolvers<Run<unknown> | null>[] = [];

    let eventLogEmpty = false;

    // Track if the event log confirms hook creation happened
    let hasCreated = false;

    // Track if the event log confirms disposal happened (replay no-op)
    let hasDisposedEvent = false;

    // Track if we have a conflict so we can reject future awaits
    let hasConflict = false;
    let conflictErrorRef: Error | null = null;
    // Set when another run took this hook's token (`experimental_force`):
    // the log's `hook_disposed` names it. Payloads received before the
    // takeover are still delivered; every await after them rejects with this.
    let forceClaimedErrorRef: HookForceClaimedError | null = null;
    // The conflicting run handle, shared by every `getConflict` await so
    // repeated awaits observe the same instance deterministically.
    let conflictRunRef: Run<unknown> | null = null;

    // Consuming a registration event is synchronous, but delivering its
    // outcome must wait for earlier branch-deciding deliveries. Keep the
    // gate for calls made after hasCreated/hasConflict becomes true as well.
    let registrationDelivered = Promise.resolve();

    // `deliveredAt` is the registration event's `createdAt`: the outcome is a
    // delivery the code after `await hook.getConflict()` (or a payload
    // awaiter rejected by a conflict) runs off, so the clock it reads is this
    // event's time.
    function deliverRegistration(
      deliveredAt: number,
      settle: () => void
    ): void {
      const eventIndex = ctx.eventsConsumer.eventIndex;
      // Always deliver, even without an awaiter yet: unlike a buffered
      // payload, registration does not need a future claim to make progress.
      const barrier = registerDeliveryBarrier(ctx, eventIndex, 'hook', {
        deliveredAt,
      });
      const earlierDelivered = awaitEarlierDeliveries(ctx, eventIndex, 'hook');
      // Never await the gate inside promiseQueue: earlier deliveries and
      // their quiescence checks need that queue to drain in order to finish.
      registrationDelivered = ctx.promiseQueue
        .then(() => earlierDelivered)
        .then(() => {
          barrier.markDelivered();
          settle();
        });
    }

    function afterRegistration(settle: () => void): void {
      const delivered = registrationDelivered;
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        void delivered.then(settle);
      });
    }

    // Lazy-resume dedup: `resumeHook()` mints a `resumeId` per resume
    // attempt and stamps it on the `hook_received` event. When the direct
    // event write fails transiently, the runtime materializes the event from
    // the queue payload instead, and because `hook_received` has no
    // storage-level uniqueness constraint, concurrent redelivery of the same
    // queue message can commit that materialization twice. Two rows for ONE
    // resume attempt then share a `resumeId` (distinct resume attempts never
    // do), so replay delivers only the first-in-log occurrence. This is a
    // pure function of the persisted event log, keeping replay deterministic.
    //
    // Scope: this is defense-in-depth over the persisted log, not a
    // cross-invocation exactly-once guarantee: an invocation replaying a
    // snapshot taken before the duplicate row committed only sees one row,
    // so two CONCURRENT invocations can each deliver from their own
    // snapshot. Every replay from a log containing both rows (i.e. all
    // subsequent deliveries) dedups. The correctness boundary that closes
    // the concurrent window is the storage-level (runId, resumeId)
    // constraint arriving with the parallel-resume successor work; this set
    // stays useful after that lands, for logs written before it deployed.
    const seenResumeIds = new Set<string>();

    webhookLogger.debug('Hook consumer setup', { correlationId, token });
    ctx.eventsConsumer.subscribe((event) => {
      // If there are no events and there are promises waiting,
      // it means the hook has been awaited, but an incoming payload has not yet been received.
      // In this case, the workflow should be suspended until the hook is resumed.
      if (!event) {
        eventLogEmpty = true;

        if (
          (promises.length > 0 && payloadsQueue.length === 0) ||
          (getConflictPromises.length > 0 && !hasCreated && !hasConflict)
        ) {
          scheduleWorkflowSuspension(ctx);
        }
        return EventConsumerResult.NotConsumed;
      }

      if (event.correlationId !== correlationId) {
        // We're not interested in this event - the correlationId belongs to a different entity
        return EventConsumerResult.NotConsumed;
      }

      const eventToken =
        'eventData' in event && event.eventData && 'token' in event.eventData
          ? event.eventData.token
          : undefined;

      if (typeof eventToken === 'string' && eventToken !== token) {
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          ctx.onWorkflowError(
            new ReplayDivergenceError(
              `Replay divergence: hook event ${event.eventType} for ${correlationId} belongs to token "${eventToken}", but the current hook consumer expects "${token}"`,
              { eventId: event.eventId }
            )
          );
        });
        return EventConsumerResult.Finished;
      }

      // Check for hook_created event to mark this hook as already created
      if (event.eventType === 'hook_created') {
        const queueItem = ctx.invocationsQueue.get(correlationId);
        if (queueItem && queueItem.type === 'hook') {
          queueItem.hasCreatedEvent = true;
          queueItem.tokenRetentionUntil = event.eventData.tokenRetentionUntil;
        }
        hasCreated = true;

        const pendingGetConflictPromises = getConflictPromises.slice();
        getConflictPromises.length = 0;
        deliverRegistration(+event.createdAt, () => {
          for (const resolver of pendingGetConflictPromises) {
            resolver.resolve(null);
          }
        });

        return EventConsumerResult.Consumed;
      }

      // Handle hook_conflict event - another workflow is using this token
      if (event.eventType === 'hook_conflict') {
        // Remove this hook from the invocations queue
        ctx.invocationsQueue.delete(correlationId);

        // Store the conflict event so we can reject any awaited promises.
        const conflictEvent = event as HookConflictEvent;
        // A forced hook asked for a guarantee — this run owns the token — that
        // a `hook_conflict` says the World could not give. Two very different
        // reasons: the World declined on purpose because the run holding the
        // token predates involuntary disposal (`forceRefusedReason`), which is
        // the ordinary conflict the caller can handle like any other; or the
        // World does not implement forcing at all (an older server, or its
        // kill switch), which is a misconfiguration worth failing loudly on.
        const forced =
          options.experimental_force === true &&
          conflictEvent.eventData.forceRefusedReason === undefined;
        const conflictError: Error = forced
          ? new FatalError(
              `createHook({ experimental_force: true }) for token "${conflictEvent.eventData.token}" was answered with a hook_conflict: the configured World does not support force-claiming hook tokens${conflictEvent.eventData.conflictingRunId ? ` (run "${conflictEvent.eventData.conflictingRunId}" holds it)` : ''}.`
            )
          : new HookConflictError(
              conflictEvent.eventData.token,
              conflictEvent.eventData.conflictingRunId
            );

        // Mark that we have a conflict so future awaits also reject
        hasConflict = true;
        conflictErrorRef = conflictError;
        conflictRunRef = forced
          ? null
          : createConflictingRun(ctx, conflictEvent.eventData.conflictingRunId);

        // Capture and drain pending promises synchronously so the null event
        // handler won't see them and trigger a spurious WorkflowSuspension.
        // The actual settlements use the registration delivery barrier.
        // Payload awaiters reject with HookConflictError, while
        // `getConflict` awaiters resolve with the conflicting run so the
        // workflow can branch on the conflict without throwing. When no
        // real `Run` can be constructed (see `createConflictingRun`),
        // `getConflict` awaiters reject with the HookConflictError instead
        // of resolving with a value that doesn't honor the `Run` contract.
        const pendingPromises = promises.slice();
        promises.length = 0;
        const pendingGetConflictPromises = getConflictPromises.slice();
        getConflictPromises.length = 0;

        deliverRegistration(+event.createdAt, () => {
          for (const resolver of pendingPromises) {
            resolver.reject(conflictError);
          }
          for (const resolver of pendingGetConflictPromises) {
            if (conflictRunRef) {
              resolver.resolve(conflictRunRef);
            } else {
              resolver.reject(conflictError);
            }
          }
        });

        return EventConsumerResult.Consumed;
      }

      if (event.eventType === 'hook_received') {
        // Drop duplicate deliveries of the same resume attempt (same
        // `resumeId`; see `seenResumeIds` above). Events without a
        // `resumeId` (older SDKs, legacy spec versions) are never deduped.
        //
        // Dedup off the top-level `resumeId` the backend hoists onto the event
        // as a first-class column. An earlier unreleased build additionally
        // wrote it nested under `eventData`, but that form never shipped and is
        // stripped by `EventSchema` parsing (the `hook_received` eventData
        // schema does not declare it), so there is no persisted nested form to
        // fall back to.
        const resumeId = event.resumeId;
        if (typeof resumeId === 'string') {
          if (seenResumeIds.has(resumeId)) {
            return EventConsumerResult.Consumed;
          }
          seenResumeIds.add(resumeId);
        }

        // Register a 'hook' delivery barrier at this event's log index so a
        // later-in-log `wait_completed` or step result is delivered only after
        // this hook, and so this hook is delivered only after every
        // earlier-in-log `wait_completed` and step result, keeping any
        // `Promise.race` (or concurrent-branch ULID allocation) deterministic
        // and aligned with the committed event log, regardless of
        // microtask-hop count, hydration time, or race-argument order.
        // See `ctx.pendingDeliveryBarriers`.
        //
        // The barrier is registered ARMED only when a consumer is already
        // awaiting, so this payload is committed to reaching the workflow. A
        // buffered payload is registered unarmed and armed by `claim()`: until
        // a consumer takes it, a later step result must not be ordered behind
        // it (see `awaitEarlierDeliveries`).
        const eventIndex = ctx.eventsConsumer.eventIndex;
        const hasWaitingConsumer = promises.length > 0;
        const barrier = registerDeliveryBarrier(ctx, eventIndex, 'hook', {
          armed: hasWaitingConsumer,
          deliveredAt: +event.createdAt,
        });

        if (hasWaitingConsumer) {
          // A consumer is already awaiting, so this payload's delivery is
          // pinned to this log position: capture the deferral HERE, while
          // consuming the event, not at the end of the hydration slot below:
          // same reasoning as step.ts. An earlier step or hook whose slot runs
          // first on this serial queue has usually delivered, and so
          // deregistered its barrier, before this slot ends. Read then, it
          // would be invisible and this payload would skip both the gate AND
          // `awaitEarlierDeliveries`' macrotask yield, letting it overtake the
          // branch that earlier delivery just woke. Every event in one drain
          // window is consumed before any slot runs, so capturing at
          // consumption time sees all of them.
          //
          // The BUFFERED branch below deliberately does NOT do this; see the
          // comment on `claim()`.
          const earlierDelivered = awaitEarlierDeliveries(
            ctx,
            eventIndex,
            'hook'
          );
          const next = promises.shift();
          if (next) {
            inFlight = next;
            // Hydrate through a promiseQueue slot (so async deserialization
            // stays in event-log order), then defer behind earlier waits and
            // steps before resolving. The deferral runs OFF the serial queue
            // (it may wait on an earlier wait or step delivery and blocking a
            // queue slot on that would deadlock the queue).
            ctx.pendingDeliveries++;
            let hydrateOutcome:
              | { ok: true; value: T }
              | { ok: false; error: unknown };
            ctx.promiseQueue = ctx.promiseQueue.then(async () => {
              try {
                const prepared =
                  await ctx.replayPayloadCache.prepareEventPayload(
                    event.eventId,
                    'payload',
                    event.eventData.payload
                  );
                const payload = await hydrateStepReturnValue(
                  event.eventData.payload,
                  ctx.runId,
                  ctx.encryptionKey,
                  ctx.globalThis,
                  {},
                  prepared
                );
                hydrateOutcome = { ok: true, value: payload as T };
              } catch (error) {
                hydrateOutcome = { ok: false, error };
              } finally {
                ctx.pendingDeliveries--;
              }
              void earlierDelivered.then(() => {
                barrier.markDelivered();
                if (inFlight === next) {
                  inFlight = undefined;
                }
                if (hydrateOutcome.ok) {
                  next.resolve(hydrateOutcome.value);
                } else {
                  next.reject(hydrateOutcome.error);
                }
              });
            });
          }
        } else {
          // No consumer is awaiting yet. Hydrate through a promiseQueue slot
          // at this log position and park the OUTCOME (value or error) for a
          // later `iterator.next()` / `await hook` claim. We capture the
          // outcome rather than eagerly resolving/rejecting a promise no
          // consumer has attached to: a rejected unclaimed promise (e.g. a
          // buffered encrypted payload with no key) would otherwise surface
          // as an unhandled rejection and crash the process. `claim()` builds
          // the consumer-facing promise on demand.
          let outcome:
            | { ok: true; value: T }
            | { ok: false; error: unknown }
            | undefined;
          const hydrated = withResolvers<void>();

          const claim = (): Promise<T> => {
            // A consumer has taken this payload, so its delivery no longer
            // waits on workflow code: later step results may now be ordered
            // behind it.
            barrier.arm();
            // Unlike every other delivery, the deferral is evaluated HERE, at
            // claim time, rather than when the event was consumed. A buffered
            // payload's delivery genuinely happens when the workflow reads the
            // hook, which may be many deliveries later; a consumption-time
            // snapshot would make the claim wait on (and pay the macrotask
            // yield for) barriers that were relevant to a moment this payload
            // never participated in. That is not theoretical: it stalls the
            // second payload in the e2e `hookWithSleepWorkflow` long enough
            // for the run to suspend before delivering it.
            return hydrated.promise
              .then(() => awaitEarlierDeliveries(ctx, eventIndex, 'hook'))
              .then(() => {
                barrier.markDelivered();
                if (outcome && !outcome.ok) {
                  throw outcome.error;
                }
                return (outcome as { ok: true; value: T }).value;
              });
          };

          ctx.pendingDeliveries++;
          ctx.promiseQueue = ctx.promiseQueue.then(async () => {
            try {
              const prepared = await ctx.replayPayloadCache.prepareEventPayload(
                event.eventId,
                'payload',
                event.eventData.payload
              );
              const payload = await hydrateStepReturnValue(
                event.eventData.payload,
                ctx.runId,
                ctx.encryptionKey,
                ctx.globalThis,
                {},
                prepared
              );
              outcome = { ok: true, value: payload as T };
            } catch (error) {
              outcome = { ok: false, error };
            } finally {
              ctx.pendingDeliveries--;
              hydrated.resolve();
            }
          });
          payloadsQueue.push({ claim });
        }

        return EventConsumerResult.Consumed;
      }

      if (event.eventType === 'hook_disposed') {
        // Terminal state - remove from queue (like step_completed/wait_completed)
        ctx.invocationsQueue.delete(correlationId);
        // Mark that the event log confirms disposal happened
        hasDisposedEvent = true;

        const claimedBy = event.eventData?.forceClaimedBy;
        if (claimedBy) {
          // Not this run's disposal: another run took the token
          // (`experimental_force`). Deliveries that landed before this row are
          // already buffered or delivered and stay valid — the takeover is
          // ordered after them — so only the awaiters that would otherwise
          // wait for a payload that now goes elsewhere are rejected, here and
          // for every later `await`. `hook_created` may be missing from the
          // log when the takeover beat a cross-region creation's journal, so
          // `getConflict` awaiters are settled too: the hook was registered,
          // it just no longer holds the token.
          const error = new HookForceClaimedError(
            token,
            claimedBy.runId,
            claimedBy.hookId
          );
          forceClaimedErrorRef = error;
          const pendingPromises = promises.slice();
          promises.length = 0;
          const pendingGetConflictPromises = getConflictPromises.slice();
          getConflictPromises.length = 0;
          ctx.promiseQueue = ctx.promiseQueue.then(() => {
            for (const resolver of pendingPromises) {
              resolver.reject(error);
            }
            for (const resolver of pendingGetConflictPromises) {
              resolver.resolve(null);
            }
          });
          webhookLogger.debug('Hook force-claimed by another run', {
            correlationId,
            token,
            claimedByRunId: claimedBy.runId,
          });
        }
        // We're done processing any more events for this hook
        return EventConsumerResult.Finished;
      }

      // This replay installed a different consumer than the stored event needs.
      ctx.promiseQueue = ctx.promiseQueue.then(() => {
        ctx.onWorkflowError(
          new ReplayDivergenceError(
            `Replay divergence: Unexpected event type for hook ${correlationId} (token: ${token}) "${event.eventType}"`,
            { eventId: event.eventId }
          )
        );
      });
      return EventConsumerResult.Finished;
    });

    // Track if the hook has been disposed
    let isDisposed = false;

    // Helper function to create a new promise that waits for the next hook payload
    function createHookPromise(): Promise<T> {
      const resolvers = withResolvers<T>();

      // A consumed conflict may still be waiting on earlier deliveries.
      if (hasConflict && conflictErrorRef) {
        afterRegistration(() => {
          resolvers.reject(conflictErrorRef);
        });
        return resolvers.promise;
      }

      // A payload already consumed from the log but not yet settled is the
      // next one in log order, ahead of anything buffered after it.
      if (inFlight) {
        return inFlight.promise;
      }

      if (payloadsQueue.length > 0) {
        const nextDelivery = payloadsQueue.shift();
        if (nextDelivery) {
          // The payload was hydrated through a promiseQueue slot at its log
          // position (buffering branch above). `claim()` builds the
          // consumer-facing promise from that outcome, deferring behind any
          // earlier-in-log wait or step and marking this hook delivered, so
          // resolution order stays anchored to the event log, not this later
          // claim site.
          return nextDelivery.claim();
        }
      }

      // Buffered payloads above are drained first: they landed before the
      // takeover. With none left, nothing can ever arrive for this hook again.
      if (forceClaimedErrorRef) {
        const error = forceClaimedErrorRef;
        ctx.promiseQueue = ctx.promiseQueue.then(() => {
          resolvers.reject(error);
        });
        return resolvers.promise;
      }

      if (eventLogEmpty) {
        scheduleWorkflowSuspension(ctx);
      }

      // Awaits made while no payload is available share one pending awaiter,
      // so the next payload settles every one of them. A `Promise.race` that
      // loses to another branch abandons its awaiter without telling the hook;
      // enrolling a fresh awaiter per `then()` would hand the next payload to
      // that abandoned await instead of the one still waiting. `inFlight`
      // above covers the same case once the payload has been consumed.
      const pending = promises[0];
      if (pending) {
        return pending.promise;
      }

      promises.push(resolvers);

      return resolvers.promise;
    }

    // Helper function to create a promise that resolves with the hook's
    // registration outcome: the conflicting `Run` when the token is owned
    // by another active hook, `null` once this hook's registration is
    // committed. Fast paths share the event's delivery gate so they cannot
    // overtake earlier deliveries while registration is still pending.
    function createGetConflictPromise(): Promise<Run<unknown> | null> {
      const resolvers = withResolvers<Run<unknown> | null>();

      if (hasCreated) {
        afterRegistration(() => {
          resolvers.resolve(null);
        });
        return resolvers.promise;
      }

      if (hasConflict) {
        afterRegistration(() => {
          if (conflictRunRef) {
            resolvers.resolve(conflictRunRef);
          } else {
            resolvers.reject(conflictErrorRef);
          }
        });
        return resolvers.promise;
      }

      const queueItem = ctx.invocationsQueue.get(correlationId);
      if (queueItem && queueItem.type === 'hook') {
        queueItem.hasConflictAwaiter = true;
      }

      if (eventLogEmpty) {
        scheduleWorkflowSuspension(ctx);
      }

      getConflictPromises.push(resolvers);
      return resolvers.promise;
    }

    // Helper function to dispose the hook
    function disposeHook(): void {
      if (isDisposed) {
        return; // Already disposed, nothing to do
      }
      isDisposed = true;

      // If the event log already contains hook_disposed, this is a replay: no-op
      if (hasDisposedEvent) {
        return;
      }

      // Set disposed flag on the existing queue item
      const queueItem = ctx.invocationsQueue.get(correlationId);
      if (queueItem && queueItem.type === 'hook') {
        queueItem.disposed = true;
      }

      // Drain any pending promises that are waiting for payloads.
      // Without this, promises created by `await hook` or the async iterator's
      // `yield await this` would hang forever since the event consumer will
      // never deliver another hook_received after disposal.
      if (promises.length > 0) {
        promises.length = 0;
        scheduleWorkflowSuspension(ctx);
      }

      webhookLogger.debug('Hook disposed', { correlationId, token });
    }

    const hook: Hook<T> = {
      token,

      getConflict(): Promise<Run<unknown> | null> {
        return createGetConflictPromise();
      },

      // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
      then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): Promise<TResult1 | TResult2> {
        return createHookPromise().then(onfulfilled, onrejected);
      },

      // Support `for await (const payload of hook) { … }` syntax
      async *[Symbol.asyncIterator]() {
        while (!isDisposed) {
          yield await this;
        }
      },

      dispose: disposeHook,

      [Symbol.dispose]: disposeHook,
    };

    // Also register with the VM's Symbol.dispose so `using` works inside
    // the workflow sandbox (the VM may have a polyfilled Symbol.dispose
    // that differs from the host's).
    const vmDispose = ctx.globalThis.Symbol.dispose;
    if (vmDispose && vmDispose !== Symbol.dispose) {
      (hook as any)[vmDispose] = disposeHook;
    }

    return hook;
  };
}
