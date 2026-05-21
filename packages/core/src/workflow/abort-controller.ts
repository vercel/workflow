import { WorkflowRuntimeError } from '@workflow/errors';
import { EventConsumerResult } from '../events-consumer.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { hydrateStepReturnValue } from '../serialization.js';
import { ABORT_HOOK_TOKEN, ABORT_STREAM_NAME } from '../symbols.js';
import { getAbortStreamId } from '../util.js';

/**
 * A lightweight AbortSignal implementation for the workflow VM context.
 *
 * `signal.aborted` and listeners are updated in two scenarios:
 * 1. On first-run: when `abort()` is called in the workflow code
 * 2. On replay: when the events consumer processes the `hook_received`
 *    event (chained through promiseQueue for deterministic ordering)
 *
 * On replay, `abort()` in the workflow code becomes a no-op since
 * `_setAborted` was already called by the events consumer.
 */
export class WorkflowAbortSignal {
  aborted = false;
  reason: unknown = undefined;

  readonly [ABORT_STREAM_NAME]: string;
  readonly [ABORT_HOOK_TOKEN]: string;

  #listeners: Array<() => void> = [];
  #onabort: ((this: WorkflowAbortSignal) => void) | null = null;

  get onabort(): ((this: WorkflowAbortSignal) => void) | null {
    return this.#onabort;
  }

  set onabort(handler: ((this: WorkflowAbortSignal) => void) | null) {
    this.#onabort = handler;
    if (handler && this.aborted) {
      handler.call(this);
    }
  }

  constructor(streamName: string, hookToken: string) {
    this[ABORT_STREAM_NAME] = streamName;
    this[ABORT_HOOK_TOKEN] = hookToken;
  }

  /**
   * @internal Sets aborted state and fires listeners.
   * Called by abort() on first-run, or by the events consumer on replay.
   * Idempotent — second call is a no-op.
   */
  _setAborted(reason?: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    if (this.#onabort) {
      this.#onabort.call(this);
    }
    for (const listener of this.#listeners) {
      listener();
    }
    this.#listeners = [];
  }

  addEventListener(type: string, listener: () => void): void {
    if (type !== 'abort') return;
    if (this.aborted) {
      // Fire synchronously, not on a microtask. Native AbortSignal fires on a
      // microtask per spec, but inside the workflow VM we deliberately diverge
      // for deterministic replay: listener ordering must be tied to the
      // orchestrator's sync execution path, not to microtask scheduling.
      listener();
      return;
    }
    this.#listeners.push(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type !== 'abort') return;
    this.#listeners = this.#listeners.filter((l) => l !== listener);
  }

  throwIfAborted(): void {
    if (this.aborted) {
      throw (
        this.reason ??
        new DOMException('The operation was aborted.', 'AbortError')
      );
    }
  }
}

/**
 * Creates a workflow-context `AbortController` class that uses hooks for
 * durable state and streams for real-time step propagation.
 *
 * Follows the same pattern as `createCreateHook()` in `workflow/hook.ts`:
 * - Registers a hook in the invocations queue on construction
 * - Subscribes to the events consumer for hook_created/hook_received events
 * - `abort()` calls `_setAborted` + marks the hook for resumption
 * - The suspension handler processes the abort (creates event + writes stream)
 * - On replay, the events consumer calls `_setAborted` when hook_received
 *   is processed, and `abort()` in the workflow code becomes a no-op
 */
export function createCreateAbortController(ctx: WorkflowOrchestratorContext) {
  return class WorkflowAbortController {
    readonly signal: WorkflowAbortSignal;
    readonly [ABORT_STREAM_NAME]: string;
    readonly [ABORT_HOOK_TOKEN]: string;

    constructor() {
      const id = ctx.generateUlid();
      const streamName = getAbortStreamId(id);
      const hookToken = `abrt_${id}`;

      this[ABORT_STREAM_NAME] = streamName;
      this[ABORT_HOOK_TOKEN] = hookToken;
      this.signal = new WorkflowAbortSignal(streamName, hookToken);

      // Register an internal system hook in the invocations queue.
      // isSystem prevents token namespace conflicts with user hooks.
      const correlationId = `hook_${ctx.generateUlid()}`;
      ctx.invocationsQueue.set(correlationId, {
        type: 'hook',
        correlationId,
        token: hookToken,
        isWebhook: false,
        isSystem: true,
      });

      // Subscribe to events for this hook's lifecycle
      ctx.eventsConsumer.subscribe((event) => {
        if (!event) {
          return EventConsumerResult.NotConsumed;
        }

        if (event.correlationId !== correlationId) {
          return EventConsumerResult.NotConsumed;
        }

        const eventToken =
          'eventData' in event && event.eventData && 'token' in event.eventData
            ? event.eventData.token
            : undefined;

        if (
          typeof eventToken === 'string' &&
          eventToken !== this[ABORT_HOOK_TOKEN]
        ) {
          ctx.promiseQueue = ctx.promiseQueue.then(() => {
            ctx.onWorkflowError(
              new WorkflowRuntimeError(
                `Corrupted event log: abort hook event ${event.eventType} for ${correlationId} belongs to token "${eventToken}", but the current abort hook expects "${this[ABORT_HOOK_TOKEN]}"`
              )
            );
          });
          return EventConsumerResult.Finished;
        }

        if (event.eventType === 'hook_created') {
          const queueItem = ctx.invocationsQueue.get(correlationId);
          if (queueItem && queueItem.type === 'hook') {
            queueItem.hasCreatedEvent = true;
          }
          return EventConsumerResult.Consumed;
        }

        if (event.eventType === 'hook_received') {
          // The abort was recorded in the event log (from a previous run's
          // abort() call, or from a step/external abort). Update signal
          // state and fire listeners at this deterministic point in the
          // promiseQueue — same ordering as hook payload delivery.
          //
          // The payload is the dehydrated form written by the suspension
          // handler (a Uint8Array, possibly encrypted). Hydrate it via the
          // same machinery as regular hook payloads (workflow/hook.ts:117)
          // so the reason round-trips with full type fidelity. Reading the
          // raw payload here is a bug — it's not a plain object after
          // dehydration, so `'reason' in payload` is false and reason
          // ends up undefined on replay.
          const rawPayload = event.eventData?.payload;
          ctx.promiseQueue = ctx.promiseQueue.then(async () => {
            let reason: unknown;
            if (rawPayload !== undefined) {
              try {
                const hydrated = (await hydrateStepReturnValue(
                  rawPayload,
                  ctx.runId,
                  ctx.encryptionKey,
                  ctx.globalThis
                )) as { reason?: unknown } | undefined;
                if (
                  hydrated &&
                  typeof hydrated === 'object' &&
                  'reason' in hydrated
                ) {
                  reason = hydrated.reason;
                }
              } catch {
                // Best-effort: if hydration fails, fall back to undefined
                // reason. The signal still aborts; the user just won't see
                // the original reason. Matches WorkflowAbortSignal's spec
                // fallback (DOMException AbortError).
              }
            }
            this.signal._setAborted(reason);
          });

          ctx.invocationsQueue.delete(correlationId);
          return EventConsumerResult.Finished;
        }

        if (event.eventType === 'hook_disposed') {
          ctx.invocationsQueue.delete(correlationId);
          return EventConsumerResult.Finished;
        }

        return EventConsumerResult.NotConsumed;
      });
    }

    abort(reason?: unknown): void {
      if (this.signal.aborted) return; // no-op (already aborted, e.g. from replay)

      // Update signal state and fire listeners synchronously
      this.signal._setAborted(reason);

      // Mark the hook for resumption so the suspension handler records
      // the abort in the event log and writes the stream packet.
      for (const [, item] of ctx.invocationsQueue) {
        if (item.type === 'hook' && item.token === this[ABORT_HOOK_TOKEN]) {
          item.abortRequested = true;
          item.abortReason = reason;
          break;
        }
      }
    }
  };
}

/**
 * Creates a workflow-context `AbortSignal` object with static methods.
 */
export function createAbortSignalStatics(): {
  abort: (reason?: unknown) => WorkflowAbortSignal;
  any: (
    signals: Iterable<{
      aborted: boolean;
      reason?: unknown;
      addEventListener?: Function;
    }>
  ) => WorkflowAbortSignal;
  timeout: () => never;
} {
  return {
    abort(reason?: unknown): WorkflowAbortSignal {
      const signal = new WorkflowAbortSignal('', '');
      signal._setAborted(
        reason ?? new DOMException('The operation was aborted.', 'AbortError')
      );
      return signal;
    },

    any(
      signals: Iterable<{
        aborted: boolean;
        reason?: unknown;
        addEventListener?: Function;
        removeEventListener?: Function;
      }>
    ): WorkflowAbortSignal {
      const composite = new WorkflowAbortSignal('', '');

      // Materialize the iterable once. Native AbortSignal.any does the same:
      // single-shot iterables (e.g. generators) would otherwise produce zero
      // entries on the second pass below.
      const arr = Array.from(signals);

      for (const signal of arr) {
        if (signal.aborted) {
          composite._setAborted(signal.reason);
          return composite;
        }
      }

      // Listen to each signal — first one to abort wins. Track listeners so
      // we can remove them after the composite aborts; otherwise the closures
      // (capturing `composite`) prevent GC for any input signal that outlives
      // the composite (e.g. a long-lived external controller).
      const listeners: Array<{
        signal: (typeof arr)[number];
        listener: () => void;
      }> = [];
      const cleanup = () => {
        for (const { signal, listener } of listeners) {
          if (signal.removeEventListener) {
            signal.removeEventListener('abort', listener);
          }
        }
        listeners.length = 0;
      };

      for (const signal of arr) {
        if (!signal.addEventListener) continue;
        const listener = () => {
          if (!composite.aborted) {
            composite._setAborted(signal.reason);
            cleanup();
          }
        };
        listeners.push({ signal, listener });
        signal.addEventListener('abort', listener);
      }

      return composite;
    },

    timeout(): never {
      throw new Error(
        'AbortSignal.timeout() is not supported in workflow functions. ' +
          'Use sleep() with an AbortController instead. ' +
          'See: /docs/errors/abort-signal-timeout-in-workflow'
      );
    },
  };
}
