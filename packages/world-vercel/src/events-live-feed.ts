/**
 * Live feed of a run's event log over the events WebSocket: the world-vercel
 * implementation of `Storage['events']['subscribe']`.
 *
 * Protocol (the backend's `docs/ws-protocol.md`): on the run's events socket
 * the client sends a request frame
 *
 *   { reqId, type: 'subscribe', afterSlot }
 *
 * which the backend answers like any request, with a reply under the same
 * `reqId` whose `status` says whether it accepted the subscription. From then
 * on it pushes, unsolicited and in slot order,
 *
 *   { type: 'run_event', event: <event meta> }   body: the event's payload
 *
 * for every event appended to the run with a slot above `afterSlot`. The
 * event meta and body are encoded exactly like a list frame, so a pushed
 * event decodes to the same `Event` a `list` with `resolveData: 'all'`
 * returns.
 *
 * The subscription lives on the connection. When the socket closes (drain,
 * transport failure, release) the feed ends and `onError` is called once; it
 * is not resumed on reconnect. Nothing depends on the feed for correctness:
 * the runtime also polls the log tail and only accepts the slot it expects
 * next, so this module drops what it has already delivered and otherwise
 * passes events through in arrival order.
 *
 * There is no unsubscribe frame: unsubscribing removes this subscriber and
 * releases its claim on the channel, which closes the socket once no other
 * invocation of the run holds it. Pushes that arrive for a removed
 * subscriber are dropped.
 */

import {
  type Event,
  type EventsSubscribeOptions,
  eventIdToSlot,
} from '@workflow/world';
import { decodeEventFrame } from './events-v4.js';
import { type DecodedFrame, encodeFrame } from './frames.js';
import type { APIConfig } from './utils.js';
import { isWsEventsTransportPossible } from './ws-transport-enabled.js';

/** Request frame type that opens a live-feed subscription. */
export const SUBSCRIBE_FRAME_TYPE = 'subscribe';

/** Raised through `onError` when the feed cannot start or stops. */
export class LiveFeedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'LiveFeedError';
  }
}

/** The event a `run_event` push carries, or `undefined` if it is malformed. */
function decodePushedEvent(frame: DecodedFrame): Event | undefined {
  const { event } = frame.meta;
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return undefined;
  }
  try {
    return decodeEventFrame({
      meta: event as Record<string, unknown>,
      body: frame.body,
    });
  } catch {
    return undefined;
  }
}

export function subscribeRunEvents(
  runId: string,
  afterSlot: number,
  onEvent: (event: Event) => void,
  options: EventsSubscribeOptions = {},
  config?: APIConfig
): () => void {
  let active = true;
  let lastSlot = afterSlot;
  let teardown: (() => void) | undefined;

  const stop = () => {
    active = false;
    const run = teardown;
    teardown = undefined;
    run?.();
  };

  /** Ends the feed and reports why, once. Never throws. */
  const fail = (error: unknown) => {
    if (!active) return;
    stop();
    try {
      options.onError?.(
        error instanceof LiveFeedError
          ? error
          : new LiveFeedError(
              `world-vercel: live feed for ${runId} stopped: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error }
            )
      );
    } catch {
      // A throwing onError must not escape into the transport.
    }
  };

  const deliver = (frame: DecodedFrame) => {
    if (!active) return;
    const event = decodePushedEvent(frame);
    if (!event) {
      fail(
        new LiveFeedError(
          `world-vercel: live feed for ${runId} received a malformed run_event frame`
        )
      );
      return;
    }
    if (event.runId !== runId) return;
    const slot = eventIdToSlot(event.eventId);
    if (slot !== null) {
      // At most once per slot; the runtime discards anything else out of
      // order on its own.
      if (slot <= lastSlot) return;
      lastSlot = slot;
    }
    onEvent(event);
  };

  if (!isWsEventsTransportPossible()) {
    queueMicrotask(() =>
      fail(
        new LiveFeedError(
          'world-vercel: live feed unavailable, the events WS transport is off'
        )
      )
    );
    return stop;
  }

  // Dynamic, like the write path: `ws` initializes only where the transport
  // is in use. The import is cached after the first call.
  void import('./ws-transport.js')
    .then(({ openWsChannel, resolveWsTransport }) => {
      if (!active) return;
      const release = openWsChannel(runId, config);
      const resolved = release ? resolveWsTransport(runId, config) : null;
      if (!release || !resolved) {
        release?.();
        fail(
          new LiveFeedError(
            `world-vercel: live feed unavailable for ${runId}, this World has no events WS channel`
          )
        );
        return;
      }
      const removeSubscriber = resolved.transport.addPushSubscriber({
        onPush: deliver,
        onClose: fail,
      });
      teardown = () => {
        removeSubscriber();
        release();
      };
      return resolved.transport
        .request((reqId) =>
          encodeFrame(
            { reqId, type: SUBSCRIBE_FRAME_TYPE, afterSlot },
            new Uint8Array(0)
          )
        )
        .then((reply) => {
          const { status } = reply.meta;
          if (typeof status === 'number' && status >= 200 && status < 300) {
            return;
          }
          fail(
            new LiveFeedError(
              `world-vercel: live feed subscription for ${runId} refused (status ${String(status ?? 'absent')}, type ${String(reply.meta.type ?? 'absent')})`
            )
          );
        });
    })
    .catch(fail);

  return stop;
}
