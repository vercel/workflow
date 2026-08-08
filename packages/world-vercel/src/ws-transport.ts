/**
 * WebSocket transport for v4 event POSTs (POC — see workflow-architecture.md
 * notes on the http→ws exploration, and the server's `docs/ws-protocol.md`
 * for the full normative wire-format/lifecycle spec this file implements
 * the client half of).
 *
 * One physical socket per (wsUrl) is kept open and shared across concurrent
 * `createWorkflowRunEventV4` calls. Every frame's meta is `{ reqId, type,
 * ... }`, with the type-specific payload nested under a field named after
 * `type` (only `event` is sent by this file today). Each logical request
 * gets a `reqId` assigned here and embedded in the outgoing frame (by the
 * caller, before `encodeFrame`); replies are matched back to their caller
 * via the same `reqId` echoed in the reply frame's meta. This mirrors the
 * multiplexing pattern already proven in the echo-bench `WsProxy`
 * (nextjs-app-1/app/echobench/ws-proxy.ts): lazy/shared connect, one socket,
 * many in-flight requests keyed by id.
 *
 * `reqId` and the pending-reply map are **per connection**, not per
 * transport: the protocol defines `reqId` as a per-connection counter, so
 * a reconnected socket restarts at 1 and would otherwise collide with the
 * previous socket's still-registered waiters. Binding both to the
 * connection object makes that structurally impossible rather than
 * something the close/reconnect paths have to remember to clean up.
 *
 * Failure handling, in short — no failure mode here is allowed to be
 * silent, because this transport has no per-request timeout and a
 * swallowed error means a caller that hangs until the socket closes:
 *
 * - **Socket errors** (broken pipe, oversize-payload 1009, protocol
 *   faults) are logged and tear the connection down. Previously the only
 *   `'error'` listener closed over the connect promise's `reject`, which
 *   is already settled once `'open'` has fired, so every post-open error
 *   was swallowed whole.
 * - **Send failures** reject the specific request. `ws.send()` on a
 *   non-OPEN socket does not throw — it reports through its callback (or,
 *   with no callback, emits `'error'`), so without the callback the
 *   request just sat in `pending` forever.
 * - **Undecodable replies** and **replies under the server's reserved
 *   malformed-frame sentinel** (`reqId: -1`) are logged loudly; neither
 *   can be correlated to a caller by construction.
 * - **Unexpected closes** eagerly reconnect (bounded backoff, see
 *   `scheduleReconnect`), on the reasoning that a socket breaking
 *   mid-run means more writes are coming. This also covers the server's
 *   graceful `drain` → `1001` sequence: the drain frame itself is
 *   informational, and the close it precedes is what triggers the
 *   reconnect. In-flight requests at close time still fail and are the
 *   caller's to retry — the server makes those retries safe via
 *   conditional writes on the entity (see the spec's idempotency notes).
 *
 * Deliberately uses the `ws` package (not the WHATWG global `WebSocket`):
 * the global constructor has no way to send custom headers on the upgrade
 * request, and `Authorization`/tenant headers need to ride the handshake
 * (auth happens once per connection, not per message — see the notes on
 * what moves from HTTP headers into frame meta vs. the handshake).
 */

import { WebSocket } from 'ws';
import { type DecodedFrame, decodeFrames } from './frames.js';

export interface WsFrameReply {
  meta: Record<string, unknown>;
  body: Uint8Array;
}

/**
 * A transport-level failure: the socket closed, or the frame could not be
 * handed to it. Distinct from an application-level error (a reply frame
 * carrying a non-2xx status), which is raised by the events adapter as a
 * typed `@workflow/errors` error instead.
 *
 * `retryable` mirrors the HTTP path's undici `errorCodes` policy: a broken
 * connection means the frame was never accepted, so re-sending it is safe.
 */
export class WsTransportError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = 'WsTransportError';
    this.retryable = opts.retryable;
  }
}

interface PendingRequest {
  resolve: (reply: WsFrameReply) => void;
  reject: (err: unknown) => void;
}

/**
 * Everything scoped to one socket. `nextReqId` and `pending` live here
 * rather than on the transport so a reconnect starts from a clean slate —
 * see the note on per-connection ids in the file header.
 */
interface Connection {
  ws: WebSocket;
  nextReqId: number;
  pending: Map<number, PendingRequest>;
}

/**
 * Reserved reqId the server replies under when a frame was too malformed
 * to recover a real reqId from (`MALFORMED_FRAME_REQ_ID` in the server's
 * websockets route). Never collides with a client-issued id — those start
 * at 1 and only increase.
 */
const MALFORMED_FRAME_REQ_ID = -1;

// Eager reconnect after an unexpected close, bounded so a server that is
// down (or an upgrade that is being rejected outright) can't turn into a
// hot reconnect loop. Once the attempts are exhausted the transport goes
// quiet and the next `request()` reconnects lazily instead.
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 100;
const RECONNECT_MAX_DELAY_MS = 5_000;

async function decodeOneFrame(raw: Uint8Array): Promise<DecodedFrame> {
  const source = (async function* () {
    yield raw;
  })();
  for await (const frame of decodeFrames(source)) {
    return frame;
  }
  throw new Error('ws-transport: received an empty/unframed message');
}

/** Pull the `{ "message": string }` JSON an `error` frame carries as its
 *  body, falling back to the raw text if it isn't shaped that way. */
function errorFrameMessage(body: Uint8Array): string {
  if (body.byteLength === 0) return '(no message)';
  const text = new TextDecoder().decode(body);
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : text;
  } catch {
    return text;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One multiplexed connection to the events WS endpoint. Not exported —
 * callers go through `getWsEventsTransport`, which caches one instance per
 * `wsUrl` for the lifetime of the process. Since `wsUrl` carries the
 * `runId` and an SDK client instance only ever drives one run, that
 * naturally yields one socket per run.
 */
class WsEventsTransport {
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly getHeaders: () => Promise<Record<string, string>>
  ) {}

  /**
   * Send one request frame and wait for its matching reply frame.
   * `buildFrame` receives the reqId to embed in the meta before framing —
   * the caller owns meta construction (buildPostFrameMeta), this class only
   * owns the socket and the reqId<->promise bookkeeping.
   */
  async request(
    buildFrame: (reqId: number) => Uint8Array
  ): Promise<WsFrameReply> {
    const conn = await this.ensureConnected();

    const reqId = conn.nextReqId++;
    const frame = buildFrame(reqId);
    return new Promise<WsFrameReply>((resolve, reject) => {
      conn.pending.set(reqId, { resolve, reject });
      conn.ws.send(frame, (err) => {
        if (!err) return;
        // `ws.send()` does not throw when the socket isn't OPEN — it
        // reports here instead. Without this callback the failure would be
        // emitted as a bare `'error'` event and this request would wait
        // for a reply that is never coming. `delete` doubles as the
        // already-settled guard: if a reply somehow landed first, the
        // entry is gone and we must not reject on top of it.
        if (conn.pending.delete(reqId)) {
          reject(
            new WsTransportError(
              `workflow-server events WS send failed: ${describeError(err)}`,
              { retryable: true, cause: err }
            )
          );
        }
      });
    });
  }

  private ensureConnected(): Promise<Connection> {
    const conn = this.connection;
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(conn);
    }
    // Clearing the slot in `finally` (rather than from the socket event
    // handlers) keeps the bookkeeping in one place and makes it impossible
    // for a stale socket's late `close` to null out a *newer* connect
    // attempt that has since taken the slot.
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private connect(): Promise<Connection> {
    return new Promise<Connection>((resolve, reject) => {
      void (async () => {
        let conn: Connection;
        try {
          // Resolved once per socket, not once per event. The bearer only
          // rides the upgrade request, so minting a token for every write
          // was pure waste — and re-resolving it here is what lets a
          // reconnect pick up a *fresh* token instead of replaying the
          // possibly-expired one the previous socket was opened with.
          const headers = await this.getHeaders();
          const ws = new WebSocket(this.wsUrl, { headers });
          ws.binaryType = 'nodebuffer';
          conn = { ws, nextReqId: 1, pending: new Map() };
        } catch (err) {
          console.error(
            `world-vercel: ws events transport could not open a connection ` +
              `to ${this.wsUrl}: ${describeError(err)}`
          );
          // A DNS failure, a refused connection, `ws` failing to load: the
          // WS analogue of undici's default retryable `errorCodes` —
          // nothing was sent, so re-sending is safe.
          reject(
            err instanceof WsTransportError
              ? err
              : new WsTransportError(
                  `workflow-server events WS connection to ${this.wsUrl} ` +
                    `could not be opened: ${describeError(err)}`,
                  { retryable: true, cause: err }
                )
          );
          return;
        }

        const { ws } = conn;
        let opened = false;

        ws.on('open', () => {
          opened = true;
          this.connection = conn;
          this.reconnectAttempts = 0;
          resolve(conn);
        });

        ws.on('message', (raw: Buffer) => {
          void this.handleMessage(conn, new Uint8Array(raw));
        });

        ws.on('error', (err) => {
          console.error(
            `world-vercel: ws events transport socket error ` +
              `(${this.wsUrl}): ${describeError(err)}`
          );
          if (!opened) {
            reject(err);
            return;
          }
          // `ws` normally follows `'error'` with `'close'`, which does the
          // teardown and schedules the reconnect. Close explicitly so that
          // still happens if it doesn't.
          ws.close();
        });

        ws.on('close', (code: number) => {
          const wasActive = this.connection === conn;
          if (wasActive) this.connection = null;

          if (!opened) {
            // A close with no preceding `'error'` would otherwise leave
            // `ensureConnected` waiting forever. Rejecting an
            // already-settled promise is a no-op, so this is safe when
            // `'error'` did fire first.
            reject(
              new WsTransportError(
                `workflow-server events WS connection to ${this.wsUrl} ` +
                  `closed before opening (code ${code})`,
                { retryable: true }
              )
            );
          }

          // Always fail this connection's own waiters — they can never be
          // answered now. `pending` being per-connection is what makes
          // this unconditional: a superseded socket's late close can only
          // ever reach its own map, never a newer socket's in-flight work.
          this.failAllPending(
            conn,
            new WsTransportError(
              `workflow-server events WS connection closed (code ${code})`,
              // The frame was in flight when the socket died, so the server
              // either never saw it or never acked it. Re-sending is safe:
              // createEvent writes are conditional on the entity server-side.
              { retryable: true }
            )
          );

          if (opened || this.reconnectAttempts > 0) {
            this.scheduleReconnect(code);
          }
        });
      })();
    });
  }

  /**
   * Reconnect eagerly rather than waiting for the next write: an
   * unexpected close mid-run (broken pipe, or the server's drain → 1001)
   * almost always means more event writes are on their way, and paying the
   * handshake now keeps it off the next write's critical path.
   *
   * Bounded on three axes so it can't degenerate into a hot loop against a
   * server that is down or rejecting the upgrade: exponential backoff, a
   * hard attempt cap after which the transport falls back to reconnecting
   * lazily on the next `request()`, and a bail-out if a newer connection
   * has already taken the slot.
   */
  private scheduleReconnect(closeCode: number): void {
    // A newer socket is already live — nothing to do. Deliberately not also
    // checking `this.connecting`: `ws` can emit `'error'` and `'close'` in
    // the same tick, so the connect promise's `finally` may not have
    // cleared that slot yet, and bailing here would silently break the
    // retry chain. `ensureConnected` already dedups, so at worst the timer
    // joins a connect that is already in flight.
    if (this.connection !== null) return;
    if (this.reconnectTimer !== null) return;

    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      console.error(
        `world-vercel: ws events transport giving up eager reconnect to ` +
          `${this.wsUrl} after ${RECONNECT_MAX_ATTEMPTS} attempts ` +
          `(last close code ${closeCode}); the next event write will retry.`
      );
      return;
    }

    const delayMs = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY_MS
    );
    this.reconnectAttempts++;

    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      // Errors are already logged by `connect`; swallow the rejection so
      // an unawaited reconnect can't surface as an unhandled rejection.
      void this.ensureConnected().catch(() => {});
    }, delayMs);
    // Never hold the event loop open for a backoff window: a handler
    // that's finished with this run should be free to exit.
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  private async handleMessage(
    conn: Connection,
    raw: Uint8Array
  ): Promise<void> {
    let decoded: DecodedFrame;
    try {
      decoded = await decodeOneFrame(raw);
    } catch (err) {
      // Not silent: an undecodable reply means whichever request it
      // belonged to can no longer be correlated, so it will sit in
      // `pending` until the socket closes with no other trace of why.
      console.error(
        `world-vercel: ws events transport could not decode a ${raw.byteLength}-byte ` +
          `reply frame from ${this.wsUrl}: ${describeError(err)}`
      );
      return;
    }

    if (decoded.meta.type === 'drain') {
      // Unsolicited server push, no reqId — the connection is closing soon
      // ahead of its maxDuration. Informational on its own; the `close`
      // that follows is what triggers the eager reconnect.
      console.log(
        `world-vercel: ws events transport received a drain notice ` +
          `(graceMs: ${decoded.meta.graceMs ?? 'unspecified'}); connection will close soon.`
      );
      return;
    }

    const reqId = decoded.meta.reqId;

    if (reqId === MALFORMED_FRAME_REQ_ID) {
      // The server couldn't parse one of our frames at all, so it replied
      // under the reserved sentinel instead of a real reqId. By
      // construction there is nothing to correlate this to — the
      // originating request stays pending until the socket closes. Loud,
      // because it means this client put a frame on the wire that the
      // server's schema rejected: a protocol bug on our side, not a
      // transient failure.
      console.error(
        `world-vercel: ws events transport received a malformed-frame error ` +
          `from ${this.wsUrl} (reserved reqId ${MALFORMED_FRAME_REQ_ID}, status ` +
          `${String(decoded.meta.status ?? 'unknown')}): ` +
          `${errorFrameMessage(decoded.body)}. The server could not parse a frame ` +
          `this client sent, so the originating write cannot be identified and ` +
          `will fail when the connection closes.`
      );
      return;
    }

    if (typeof reqId !== 'number') {
      console.error(
        `world-vercel: ws events transport received a reply frame with no ` +
          `numeric reqId from ${this.wsUrl} (type: ` +
          `${String(decoded.meta.type ?? 'absent')}); dropping it.`
      );
      return;
    }

    const pending = conn.pending.get(reqId);
    if (!pending) {
      console.error(
        `world-vercel: ws events transport received a reply for unknown ` +
          `reqId ${reqId} from ${this.wsUrl} (already settled, or the request ` +
          `was failed by a send error); dropping it.`
      );
      return;
    }
    conn.pending.delete(reqId);
    pending.resolve({ meta: decoded.meta, body: decoded.body });
  }

  private failAllPending(conn: Connection, err: unknown): void {
    for (const pending of conn.pending.values()) {
      pending.reject(err);
    }
    conn.pending.clear();
  }
}

const transports = new Map<string, WsEventsTransport>();

/**
 * Get (or lazily create) the shared WS transport for `wsUrl`.
 *
 * `getHeaders` is invoked once per socket — at connect time, not per
 * request — since the `Authorization` header only rides the upgrade.
 * A reconnect calls it again, so each new socket is opened with a freshly
 * resolved token rather than replaying the previous socket's.
 *
 * Only the first caller's `getHeaders` for a given `wsUrl` is retained.
 * That's fine in practice because `wsUrl` embeds the `runId` and one run
 * is always driven by one client instance.
 */
export function getWsEventsTransport(
  wsUrl: string,
  getHeaders: () => Promise<Record<string, string>>
): WsEventsTransport {
  let transport = transports.get(wsUrl);
  if (!transport) {
    transport = new WsEventsTransport(wsUrl, getHeaders);
    transports.set(wsUrl, transport);
  }
  return transport;
}

/** Test seam: drop the process-wide transport cache. */
export function resetWsEventsTransportsForTest(): void {
  transports.clear();
}

/**
 * Derive the WS protocol endpoint URL for one run, from the (http/https)
 * base URL used for v4 REST calls. Path is `/websockets/v1/runs/:runId` —
 * a general-purpose entry point versioned independently of the `v4` REST
 * API version this transport happens to forward `event` frames into (was
 * `/v4/events/ws`, then `/websockets/v1` with no `runId`; see the server's
 * `docs/ws-protocol.md` for why the two version axes are kept separate).
 *
 * Scoped to one run rather than shared across runs: a single SDK client
 * instance only ever drives one run, never several concurrently, so
 * there's no multi-run multiplexing to support — `runId` belongs on the
 * connection, not repeated on every frame. `getWsEventsTransport` caches
 * one physical socket per `wsUrl`, so this naturally yields one socket
 * per run.
 */
export function toEventsWsUrl(baseUrl: string, runId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/websockets/v1/runs/${encodeURIComponent(runId)}`;
  return url.toString();
}
