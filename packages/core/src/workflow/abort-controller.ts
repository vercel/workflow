import { EventConsumerResult } from '../events-consumer.js';
import type { WorkflowOrchestratorContext } from '../private.js';
import { ABORT_HOOK_TOKEN, ABORT_STREAM_NAME } from '../symbols.js';
import { getAbortStreamId } from '../util.js';

/**
 * A lightweight AbortSignal implementation for the workflow VM context.
 *
 * In the workflow, `signal.aborted` is backed by the internal hook's event log.
 * It is NOT set synchronously when `abort()` is called — instead, the hook is
 * marked for resumption, and the replay updates the state at the deterministically
 * correct point.
 */
class WorkflowAbortSignal {
  aborted = false;
  reason: unknown = undefined;

  readonly [ABORT_STREAM_NAME]: string;
  readonly [ABORT_HOOK_TOKEN]: string;

  #listeners: Array<() => void> = [];

  /**
   * Set by the events consumer during replay when hook_received is processed.
   * The actual _setAborted (with listener firing) is deferred until abort()
   * is called in the workflow code, ensuring listeners fire at the same point
   * in both first-run and replay.
   */
  _replayAbortReason: { set: true; reason: unknown } | undefined;

  constructor(streamName: string, hookToken: string) {
    this[ABORT_STREAM_NAME] = streamName;
    this[ABORT_HOOK_TOKEN] = hookToken;
  }

  /** @internal Called by abort() to update state and fire listeners */
  _setAborted(reason?: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    for (const listener of this.#listeners) {
      listener();
    }
    this.#listeners = [];
  }

  /**
   * @internal Called by the events consumer during replay.
   * Records that abort happened but defers listener firing until abort() is called.
   */
  _markAbortedFromReplay(reason?: unknown): void {
    if (this.aborted) return;
    this._replayAbortReason = { set: true, reason };
    // Set aborted=true so reads return true, but DON'T fire listeners.
    // Listeners will fire when abort() is called in the workflow code.
    this.aborted = true;
    this.reason = reason;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type !== 'abort') return;
    if (this.aborted) {
      // Fire immediately if already aborted
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
 * - `abort()` marks the hook for resumption (like `hook.dispose()`)
 * - The suspension handler processes the abort (creates event + writes stream)
 * - On replay, the events consumer updates `signal.aborted` at the correct point
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
        // End of event log — if abort was requested but not yet processed,
        // the workflow will suspend and the suspension handler will create
        // the hook_received event.
        if (!event) {
          return EventConsumerResult.NotConsumed;
        }

        if (event.correlationId !== correlationId) {
          return EventConsumerResult.NotConsumed;
        }

        if (event.eventType === 'hook_created') {
          const queueItem = ctx.invocationsQueue.get(correlationId);
          if (queueItem && queueItem.type === 'hook') {
            queueItem.hasCreatedEvent = true;
          }
          return EventConsumerResult.Consumed;
        }

        if (event.eventType === 'hook_received') {
          // The abort was recorded in the event log during a previous run.
          // Mark the signal as aborted (so reads return true) but DON'T fire
          // listeners yet — they'll fire when abort() is called in the workflow
          // code, ensuring consistent ordering between first-run and replay.
          const payload = event.eventData?.payload;
          const reason =
            payload && typeof payload === 'object' && 'reason' in payload
              ? payload.reason
              : undefined;

          // Chain through promiseQueue for deterministic ordering
          ctx.promiseQueue = ctx.promiseQueue.then(() => {
            this.signal._markAbortedFromReplay(reason);
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
      // If already aborted from replay (_markAbortedFromReplay was called),
      // fire listeners now at the abort() call site for consistent ordering.
      if (this.signal._replayAbortReason?.set) {
        const replayReason = this.signal._replayAbortReason.reason;
        this.signal._replayAbortReason = undefined;
        // aborted is already true, but listeners haven't fired yet.
        // Temporarily reset and call _setAborted to fire them.
        this.signal.aborted = false;
        this.signal._setAborted(replayReason);
        return; // Hook was already processed during replay, no queue changes needed
      }

      if (this.signal.aborted) return; // true no-op (listeners already fired)

      // First run: update signal and fire listeners synchronously
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
export function createAbortSignalStatics(_vmGlobalThis: Record<string, any>): {
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
      }>
    ): WorkflowAbortSignal {
      const composite = new WorkflowAbortSignal('', '');

      for (const signal of signals) {
        if (signal.aborted) {
          composite._setAborted(signal.reason);
          return composite;
        }
      }

      // Listen to each signal — first one to abort wins
      for (const signal of signals) {
        if (signal.addEventListener) {
          signal.addEventListener('abort', () => {
            if (!composite.aborted) {
              composite._setAborted(signal.reason);
            }
          });
        }
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
