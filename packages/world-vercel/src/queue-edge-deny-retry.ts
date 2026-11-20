/**
 * One delayed retry for a queue reschedule that the Vercel edge refused.
 *
 * When a delivery's handler fails (or asks for a redelivery), `@vercel/queue`
 * reschedules the message with a lease PATCH. If that PATCH fails,
 * `@vercel/queue` logs `Failed to reschedule message for retry:` and answers
 * the push as a success: the message is then neither acknowledged nor
 * rescheduled, and only comes back once its 300s claim lapses. Its in-process
 * retry covers network errors and 429s, never a 403 (vercel/workflow#4829).
 *
 * A 403 has two possible origins, and only one is worth retrying:
 *
 * - Vercel Queues decided it. Retrying presents the same token and changes
 *   nothing, so it is left alone (as `queue-send-retry.ts` does for sends).
 * - The Vercel edge refused the request before it reached Vercel Queues (a
 *   Vercel Firewall deny). Only the edge sets `x-vercel-mitigated`, so its
 *   presence on the response is what tells the two apart.
 *
 * `@vercel/queue`'s `ForbiddenError` carries neither the status nor the
 * headers, so the decision has to be made on the response itself, in an
 * interceptor on world-vercel's queue dispatcher. An edge-refused reschedule is
 * retried exactly once, {@link QUEUE_EDGE_DENY_RETRY_DELAY_MS} later. A deny
 * usually means the edge is shedding traffic, so the retry is deliberately
 * single and late rather than quick and repeated: it costs at most one extra
 * request per refused reschedule. If the retry is refused too, its 403 goes up
 * to `@vercel/queue` as before.
 *
 * Only the reschedule is retried, not the lease extensions that run while the
 * handler does: a late extension landing after the reschedule would undo it.
 * The `retry` hook world-vercel gives `@vercel/queue` runs right before the
 * reschedule, in the delivery's async context, and marks the delivery with
 * {@link markQueueReschedule}; a lease PATCH dispatched after that mark is the
 * reschedule.
 *
 * Applies only where world-vercel builds the queue dispatcher on undici (see
 * `createQueueDispatcher`); under `WORKFLOW_NODE_HTTP`, or with a caller's own
 * dispatcher, a refused reschedule behaves as it did before.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders } from 'node:http';
import { globalSingleton } from '@workflow/utils';
import { DecoratorHandler, type Dispatcher } from 'undici';

/** How long to wait before retrying a reschedule the edge refused. */
export const QUEUE_EDGE_DENY_RETRY_DELAY_MS = 10_000;

interface DeliveryScope {
  rescheduling: boolean;
}

/**
 * Process-wide, like the queue dispatcher this feeds (`httpPools` in
 * http-client.ts): the interceptor and the `retry` hook that marks a delivery
 * may come from different bundled copies of this module.
 */
const state = globalSingleton(
  '@workflow/world-vercel//queueEdgeDenyRetry',
  1,
  () => ({
    deliveryScope: new AsyncLocalStorage<DeliveryScope>(),
    retryDelayOverrideMs: undefined as number | undefined,
  })
);

/** Shortens the retry delay in tests; `undefined` restores the default. */
export function setQueueEdgeDenyRetryDelayForTests(
  delayMs: number | undefined
): void {
  state.retryDelayOverrideMs = delayMs;
}

/** Runs one queue delivery in its own scope (see {@link markQueueReschedule}). */
export function runQueueDelivery<T>(fn: () => T): T {
  return state.deliveryScope.run({ rescheduling: false }, fn);
}

/**
 * Marks the current delivery as rescheduling: from here on, a lease PATCH it
 * dispatches is the reschedule, and may be retried once if the edge refuses it.
 */
export function markQueueReschedule(): void {
  const scope = state.deliveryScope.getStore();
  if (scope) scope.rescheduling = true;
}

function isReschedule(opts: Dispatcher.DispatchOptions): boolean {
  return (
    state.deliveryScope.getStore()?.rescheduling === true &&
    opts.method === 'PATCH' &&
    /\/consumer\/[^/]+\/lease\/[^/?]+/.test(opts.path)
  );
}

function isAsyncIterable(body: unknown): body is AsyncIterable<Uint8Array> {
  return (
    !!body &&
    typeof body !== 'string' &&
    !Buffer.isBuffer(body) &&
    typeof (body as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}

/** A 403 the Vercel edge sent, not the service behind it. */
function isEdgeDeny(statusCode: number, headers: IncomingHttpHeaders): boolean {
  return statusCode === 403 && headers['x-vercel-mitigated'] !== undefined;
}

/**
 * The handler for one reschedule: forwards the response, except a first 403
 * from the edge, which it drops and replaces with one retry after the delay.
 * The downstream handler sees a single request, through a controller that
 * follows whichever attempt is current.
 */
class EdgeDenyRetryHandler implements Dispatcher.DispatchHandler {
  #dispatch: Dispatcher['dispatch'];
  #opts: Dispatcher.DispatchOptions;
  #downstream: Dispatcher.DispatchHandler;
  #controller: Dispatcher.DispatchController | undefined;
  #started = false;
  #retried = false;
  #dropping = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #proxy: Dispatcher.DispatchController;

  constructor(
    dispatch: Dispatcher['dispatch'],
    opts: Dispatcher.DispatchOptions,
    downstream: Dispatcher.DispatchHandler
  ) {
    this.#dispatch = dispatch;
    this.#opts = opts;
    this.#downstream = downstream;
    const self = this;
    this.#proxy = {
      get aborted() {
        return self.#controller?.aborted ?? false;
      },
      get paused() {
        return self.#controller?.paused ?? false;
      },
      get reason() {
        return self.#controller?.reason ?? null;
      },
      abort(reason: Error) {
        if (self.#timer !== undefined) {
          // Aborted while waiting to retry: there is no request in flight.
          clearTimeout(self.#timer);
          self.#timer = undefined;
          self.#downstream.onResponseError?.(self.#proxy, reason);
          return;
        }
        self.#controller?.abort(reason);
      },
      pause() {
        self.#controller?.pause();
      },
      resume() {
        self.#controller?.resume();
      },
    };
  }

  onRequestStart(controller: Dispatcher.DispatchController, context: unknown) {
    this.#controller = controller;
    if (this.#started) return;
    this.#started = true;
    this.#downstream.onRequestStart?.(this.#proxy, context);
  }

  onRequestUpgrade(
    _controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: IncomingHttpHeaders,
    socket: Parameters<
      NonNullable<Dispatcher.DispatchHandler['onRequestUpgrade']>
    >[3]
  ) {
    this.#downstream.onRequestUpgrade?.(
      this.#proxy,
      statusCode,
      headers,
      socket
    );
  }

  onResponseStart(
    _controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: IncomingHttpHeaders,
    statusMessage?: string
  ) {
    if (!this.#retried && isEdgeDeny(statusCode, headers)) {
      this.#dropping = true;
      return;
    }
    this.#downstream.onResponseStart?.(
      this.#proxy,
      statusCode,
      headers,
      statusMessage
    );
  }

  onResponseData(_controller: Dispatcher.DispatchController, chunk: Buffer) {
    if (this.#dropping) return;
    this.#downstream.onResponseData?.(this.#proxy, chunk);
  }

  onResponseEnd(
    _controller: Dispatcher.DispatchController,
    trailers: IncomingHttpHeaders
  ) {
    if (!this.#dropping) {
      this.#downstream.onResponseEnd?.(this.#proxy, trailers);
      return;
    }
    this.#dropping = false;
    this.#retried = true;
    const delayMs =
      state.retryDelayOverrideMs ?? QUEUE_EDGE_DENY_RETRY_DELAY_MS;
    console.warn(
      `[workflow] The Vercel edge refused a queue reschedule with 403; retrying it once in ${delayMs / 1000}s`
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#dispatch(this.#opts, this);
    }, delayMs);
  }

  onResponseError(_controller: Dispatcher.DispatchController, error: Error) {
    this.#downstream.onResponseError?.(this.#proxy, error);
  }
}

/**
 * The interceptor for world-vercel's queue dispatcher: a reschedule (see
 * {@link markQueueReschedule}) the Vercel edge refuses with 403 is retried
 * once, after {@link QUEUE_EDGE_DENY_RETRY_DELAY_MS}. Every other request
 * passes through untouched.
 */
export function queueEdgeDenyRetryInterceptor(
  dispatch: Dispatcher['dispatch']
): Dispatcher['dispatch'] {
  return (opts, handler) => {
    if (!isReschedule(opts)) return dispatch(opts, handler);
    // Adapts a handler written against undici's older callback API.
    const downstream = new DecoratorHandler(
      handler
    ) as unknown as Dispatcher.DispatchHandler;
    const { body } = opts;
    if (!isAsyncIterable(body)) {
      return dispatch(
        opts,
        new EdgeDenyRetryHandler(dispatch, opts, downstream)
      );
    }
    // `fetch` hands the body down as a one-shot stream; a retry needs it
    // again. A reschedule's body is a few bytes of JSON.
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        const buffered = { ...opts, body: Buffer.concat(chunks) };
        dispatch(
          buffered,
          new EdgeDenyRetryHandler(dispatch, buffered, downstream)
        );
      } catch (error) {
        downstream.onResponseError?.(
          undefined as unknown as Dispatcher.DispatchController,
          error as Error
        );
      }
    })();
    return true;
  };
}
