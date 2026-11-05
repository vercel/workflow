/**
 * Live feed of a run's event log over the events WebSocket: the world-vercel
 * implementation of `Storage['events']['subscribe']`.
 *
 * Protocol (the backend's `docs/ws-protocol.md`): on the run's events socket
 * the client sends a request frame
 *
 *   { reqId, type: 'subscribe', afterSlot }
 *
 * which the backend answers with `subscribe_ack` (status 200), or an `error`
 * reply (400 for a run that is not single-orchestrator). From then on it
 * pushes, unsolicited and in slot order,
 *
 *   { reqId: <the subscribe's>, type: 'run_event', slot }
 *   body: one complete event frame, byte-identical to a list frame
 *
 * for every event appended to the run with a slot above `afterSlot`, sealed
 * `noop` positions included, so a pushed event decodes to the same `Event` a
 * `list` with `resolveData: 'all'` returns. A second `subscribe` on the same
 * connection replaces the first; invocations of one run share a socket, so
 * every subscriber on it receives whatever the connection's latest
 * subscription pushes, filtered to slots it has not delivered yet.
 *
 * When the backend ends a running feed (it is throttled for too long, an
 * event is too large to send, a later read is refused) it pushes one last
 *
 *   { reqId, type: 'run_event', end: true, status, error, message }
 *
 * with no slot and an empty body; the feed then ends and `onError` gets that
 * status, code and message.
 *
 * Heartbeats. This client lists `run-heartbeat` in its upgrade flags. A
 * backend that sends heartbeats says so on the ack (`heartbeatMs`), and then
 * pushes, after a successful read once it has sent nothing for `heartbeatMs`,
 *
 *   { reqId, type: 'run_heartbeat', slot }
 *
 * naming the highest slot it has pushed. On such an ack the feed calls
 * `onWatched` and watches itself:
 *
 * - no push and no heartbeat for {@link HEARTBEAT_SILENCE_FACTOR} times
 *   `heartbeatMs` ends the feed (`onError`): it died without a sign (a
 *   half-open socket, a backend feed that stopped without a notice, reads
 *   failing for that long);
 * - a heartbeat naming a slot above the last one delivered calls `onGap`
 *   once for that range: pushes went missing (a replacement subscription
 *   that started above this one), and the caller reads the log;
 * - a heartbeat under another `reqId` after this subscription's ack ends the
 *   feed: a later `subscribe` on the connection replaced it.
 *
 * Against a backend that predates heartbeats the ack has no `heartbeatMs`,
 * and none of this is armed.
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
import { type DecodedFrame, decodeFrame, encodeFrame } from './frames.js';
import type { APIConfig } from './utils.js';
import { isWsEventsTransportPossible } from './ws-transport-enabled.js';

/** Request frame type that opens a live-feed subscription. */
export const SUBSCRIBE_FRAME_TYPE = 'subscribe';

/**
 * How many heartbeat intervals of silence end a watched feed. The backend
 * sends a heartbeat within one interval plus one idle read (5 s) of its last
 * frame, so three leaves room for a slow read and network delay.
 */
export const HEARTBEAT_SILENCE_FACTOR = 3;

/** The ack's heartbeat interval, when it confirms heartbeats. */
function ackedHeartbeatMs(meta: Record<string, unknown>): number | undefined {
  const value = meta.heartbeatMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** Raised through `onError` when the feed cannot start or stops. */
export class LiveFeedError extends Error {
  /** The backend's status, when the backend ended or refused the feed. */
  readonly status?: number;
  /** The backend's error code, when it sent one. */
  readonly code?: string;

  constructor(
    message: string,
    options?: { cause?: unknown; status?: number; code?: string }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'LiveFeedError';
    this.status = options?.status;
    this.code = options?.code;
  }
}

/** A push's slot: the frame's own, else the event id's. */
function pushedSlot(frame: DecodedFrame, event: Event): number | null {
  return typeof frame.meta.slot === 'number' &&
    Number.isSafeInteger(frame.meta.slot)
    ? frame.meta.slot
    : eventIdToSlot(event.eventId);
}

/** The backend's terminal notice: a `run_event` that ends the feed. */
function endedByBackend(
  runId: string,
  frame: DecodedFrame
): LiveFeedError | undefined {
  if (frame.meta.end !== true) return undefined;
  const status =
    typeof frame.meta.status === 'number' ? frame.meta.status : undefined;
  const code =
    typeof frame.meta.error === 'string' ? frame.meta.error : undefined;
  const message =
    typeof frame.meta.message === 'string' ? frame.meta.message : '';
  return new LiveFeedError(
    `world-vercel: live feed for ${runId} ended by the backend (status ${String(status ?? 'absent')}, ${code ?? 'no code'})${message ? `: ${message}` : ''}`,
    { status, code }
  );
}

/** The event a `run_event` push carries, or `undefined` if it is malformed. */
function decodePushedEvent(frame: DecodedFrame): Event | undefined {
  try {
    return decodeEventFrame(decodeFrame(frame.body));
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
  /** This subscription's `reqId` on the connection, once sent. */
  let ownReqId: number | undefined;
  /** Whether the backend acked this subscription. */
  let acked = false;
  /** The silence that ends a watched feed; set once an ack confirms heartbeats. */
  let silenceMs: number | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  /** The highest slot a gap was already reported up to. */
  let gapReportedThrough = afterSlot;

  const clearSilence = () => {
    if (silenceTimer !== undefined) clearTimeout(silenceTimer);
    silenceTimer = undefined;
  };
  /** Starts the silence clock over: the backend was heard from. */
  const heard = () => {
    if (!active || silenceMs === undefined) return;
    clearSilence();
    silenceTimer = setTimeout(() => {
      silenceTimer = undefined;
      fail(
        new LiveFeedError(
          `world-vercel: live feed for ${runId} went silent: no push or heartbeat for ${silenceMs}ms`,
          { code: 'run-feed-silent' }
        )
      );
    }, silenceMs);
    // Never keep a process alive for the watchdog alone.
    (silenceTimer as { unref?: () => void }).unref?.();
  };

  const stop = () => {
    active = false;
    clearSilence();
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

  const onHeartbeat = (frame: DecodedFrame) => {
    if (!active || !acked) return;
    if (frame.meta.reqId !== ownReqId) {
      fail(
        new LiveFeedError(
          `world-vercel: live feed for ${runId} was replaced by a later subscription on the connection`,
          { code: 'run-feed-replaced' }
        )
      );
      return;
    }
    heard();
    const slot = frame.meta.slot;
    if (
      typeof slot === 'number' &&
      Number.isSafeInteger(slot) &&
      slot > lastSlot &&
      slot > gapReportedThrough
    ) {
      gapReportedThrough = slot;
      try {
        options.onGap?.();
      } catch {
        // A throwing onGap must not escape into the transport.
      }
    }
  };

  const deliver = (frame: DecodedFrame) => {
    if (!active) return;
    const ended = endedByBackend(runId, frame);
    if (ended) {
      fail(ended);
      return;
    }
    heard();
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
    const slot = pushedSlot(frame, event);
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
        onHeartbeat,
        onClose: fail,
      });
      teardown = () => {
        removeSubscriber();
        release();
      };
      return resolved.transport
        .request((reqId) => {
          ownReqId = reqId;
          return encodeFrame(
            { reqId, type: SUBSCRIBE_FRAME_TYPE, afterSlot },
            new Uint8Array(0)
          );
        })
        .then((reply) => {
          const { status } = reply.meta;
          if (typeof status === 'number' && status >= 200 && status < 300) {
            if (!active) return;
            acked = true;
            const heartbeatMs = ackedHeartbeatMs(reply.meta);
            if (heartbeatMs !== undefined) {
              silenceMs = heartbeatMs * HEARTBEAT_SILENCE_FACTOR;
              heard();
              try {
                options.onWatched?.({ silenceMs });
              } catch {
                // A throwing onWatched must not escape into the transport.
              }
            }
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
