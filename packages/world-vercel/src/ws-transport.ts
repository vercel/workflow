/**
 * Client half of the events WebSocket protocol. The normative wire-format and
 * lifecycle spec is the server's `docs/ws-protocol.md`.
 *
 * One socket per `wsUrl` (which embeds the runId) is shared across concurrent
 * `createWorkflowRunEventV4` calls and multiplexed by `reqId`. Frame meta is
 * `{ reqId, type, ... }`, with the type-specific payload nested under a field
 * named after `type` (only `event` is sent today). The caller builds the meta;
 * this file owns the socket and the reqId<->promise bookkeeping.
 *
 * Every failure mode has to reach the caller waiting on it: a swallowed error
 * here is a hung invocation, not a lost log line. Whether a failed write is
 * re-sent is `event-retry.ts`'s decision, not this file's: `WsTransportError`
 * is mapped to the same `code: 'TRANSPORT'` shape a failed `fetch` produces.
 *
 * Uses the `ws` package rather than the WHATWG global `WebSocket`, which cannot
 * set headers on the upgrade request; auth rides the handshake, once per
 * connection instead of once per message.
 *
 * Transport *selection* lives at the bottom of the file (the opt-in flag,
 * which Worlds can hold a socket at all, and the pre-warm entry point) so
 * `events-v4.ts` consumes one seam instead of assembling the transport.
 */

import { getVercelOidcToken } from '@vercel/oidc';
import { globalSingleton } from '@workflow/utils';
import { WebSocket } from 'ws';
import { type DecodedFrame, decodeFrames } from './frames.js';
import {
  getRequestTimeoutMs,
  headersToRecord,
  withHttpClientSpan,
} from './http-core.js';
import {
  ErrorType,
  injectTraceContextIntoHeaders,
  NetworkProtocolName,
  WorkflowEventsTransport,
  WorkflowWsReconnectAttempt,
} from './telemetry.js';
import { type APIConfig, getHttpConfig, getHttpUrl } from './utils.js';
import { version } from './version.js';
import { isWsEventsTransportEnabled } from './ws-transport-enabled.js';

export interface WsFrameReply {
  meta: Record<string, unknown>;
  body: Uint8Array;
}

/**
 * A transport-level failure: the socket closed, the frame could not be handed
 * to it, or a reply arrived that cannot be correlated to a caller, always
 * before the frame was acked. Distinct from an application-level error (a reply
 * carrying a non-2xx status), which the events adapter raises as a typed
 * `@workflow/errors` error. Carries no retry policy of its own;
 * `postEventFrameOverWs` maps it to `code: 'TRANSPORT'`.
 */
export class WsTransportError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.name = 'WsTransportError';
  }
}

interface PendingRequest {
  resolve: (reply: WsFrameReply) => void;
  reject: (err: unknown) => void;
}

/**
 * Everything scoped to one socket. `nextReqId` and `pending` live here rather
 * than on the transport because the protocol defines `reqId` as a
 * per-connection counter: a reconnected socket restarts at 1 and would
 * otherwise collide with the previous socket's still-registered waiters.
 */
interface Connection {
  ws: WebSocket;
  nextReqId: number;
  pending: Map<number, PendingRequest>;
}

/** Reserved reqId the server replies under when a frame was too malformed to
 *  recover a real one from. Client-issued ids start at 1 and only increase. */
const MALFORMED_FRAME_REQ_ID = -1;

// Bounded so a server that is down, or an upgrade being rejected outright,
// can't become a hot reconnect loop. Once exhausted the transport goes quiet
// and the next `request()` reconnects lazily instead.
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 100;
const RECONNECT_MAX_DELAY_MS = 5_000;

/** Absent on servers predating the field, which only ever drained for
 *  maxDuration, so absent reads as `max_duration`. */
type DrainReason = 'max_duration' | 'auth_expiry';

/** `getHeaders` is a caller-supplied thunk and shouldn't have to guarantee
 *  lowercased keys the way `Headers.forEach` does. */
function readAuthorization(headers: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization') return value;
  }
  return null;
}

async function decodeOneFrame(raw: Uint8Array): Promise<DecodedFrame> {
  const source = (async function* () {
    yield raw;
  })();
  for await (const frame of decodeFrames(source)) {
    return frame;
  }
  throw new Error('ws-transport: received an empty/unframed message');
}

/** Pull the `{ "message": string }` JSON an `error` frame carries as its body,
 *  falling back to the raw text if it isn't shaped that way. */
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
 * One multiplexed connection to the events WS endpoint. Not exported: callers
 * go through `getWsEventsTransport`, which caches one instance per `wsUrl`.
 */
class WsEventsTransport {
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Number of `open()` calls not yet matched by a `release()`. The socket goes
   *  away at zero. A refcount rather than a flag because concurrent invocations
   *  for one run share this instance; see `open`. */
  private openCount = 0;
  /** Set by `close()`. Suppresses reconnects so an intentional teardown can't
   *  be undone by the close handler it triggers. */
  private closed = false;
  /** Reason from the most recent `drain`, consumed by the close that follows. */
  private lastDrainReason: DrainReason | null = null;
  /** A drain said the *token* expired, not that the socket aged out, so the
   *  next connect must not reuse the same bearer. */
  private needsFreshToken = false;
  /** Authorization the current socket was opened with, so a forced refresh can
   *  tell whether it actually produced a new one. */
  private lastAuthorization: string | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly getHeaders: (opts: {
      forceRefresh: boolean;
    }) => Promise<Record<string, string>>
  ) {}

  /** Send one request frame and wait for its matching reply. `buildFrame`
   *  receives the reqId to embed in the meta before framing. */
  async request(
    buildFrame: (reqId: number) => Uint8Array
  ): Promise<WsFrameReply> {
    if (this.closed) {
      // Unreachable through `resolveWsTransport`, which only hands back a
      // registered channel and `close()` de-registers synchronously. Reviving
      // here instead would recreate the socket nobody owns that the explicit
      // open/close pair exists to rule out.
      throw new WsTransportError(
        `workflow-server events WS channel for ${this.wsUrl} is closed`
      );
    }
    const conn = await this.ensureConnected();

    const reqId = conn.nextReqId++;
    const frame = buildFrame(reqId);
    const timeoutMs = getRequestTimeoutMs();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<WsFrameReply>((resolve, reject) => {
        conn.pending.set(reqId, { resolve, reject });
        // Deliberately the same knob the HTTP path uses. Without it, a reply
        // that never arrives for a reason the error/close handling doesn't
        // cover blocks the caller until the platform's `maxDuration`
        // SIGTERM, including a server that accepts a frame and never
        // answers it.
        deadline = setTimeout(() => {
          if (!conn.pending.delete(reqId)) return;
          reject(
            new WsTransportError(
              `workflow-server events WS request ${reqId} to ${this.wsUrl} ` +
                `timed out after ${timeoutMs}ms with no reply`
            )
          );
          // A socket that accepted a frame and never answered it is not one
          // the next write should be handed.
          this.failConnection(
            conn,
            `workflow-server events WS connection to ${this.wsUrl} ` +
              `abandoned after request ${reqId} timed out`
          );
        }, timeoutMs);
        deadline.unref?.();
        conn.ws.send(frame, (err) => {
          if (!err) return;
          // `ws.send()` does not throw when the socket isn't OPEN; it
          // reports here instead, so without this callback the request would
          // wait for a reply that is never coming. `delete` doubles as the
          // already-settled guard.
          if (conn.pending.delete(reqId)) {
            reject(
              new WsTransportError(
                `workflow-server events WS send failed: ${describeError(err)}`,
                { cause: err }
              )
            );
          }
        });
      });
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  }

  /**
   * Claim the channel and start connecting. Called once per invocation that
   * intends to write, at the point the run id is known. Connecting lazily on
   * the first write instead bills the handshake (plus the OIDC mint riding it)
   * to whichever event happens to be written first; when that's a `step_started`
   * issued as the step body already runs, its server-recorded timestamp lands
   * after the work it timestamps and the step reads as shorter than it was.
   *
   * Fire-and-forget: the connect is unawaited, and `request` awaits the same
   * promise, so a write issued while the handshake is still in flight joins it
   * rather than racing it.
   *
   * A failed connect closes the channel rather than leaving it registered for
   * `request` to retry, which is what keeps this path from being *worse* than
   * HTTP: writes resolve no channel and take the pooled HTTP route instead of
   * paying another handshake attempt each.
   *
   * That de-opt covers the handshake only. A channel that connects and then
   * fails every write stays registered and keeps taking the WS path, so the
   * fallback is per-invocation rather than a circuit breaker. Tolerable while
   * the transport is opt-in; defaulting it on needs a write-failure de-opt too.
   */
  open(): void {
    if (this.closed) return;
    this.openCount++;
    if (this.connection !== null || this.connecting !== null) return;
    void this.ensureConnected().catch(() => {
      // Already logged by `connect`.
      this.close('connect failed');
    });
  }

  /**
   * Give up this invocation's claim, dropping the socket once the last holder
   * does. Concurrent invocations for one run share this instance (inline step
   * executions ride the flow topic on per-step topics, so a run's steps can be
   * separate invocations of the same container), and the first to finish must
   * not tear the socket out from under the others.
   *
   * Unbalanced calls are inert: without a matching `open` there is nothing to
   * release, and the count floors at zero rather than going negative and
   * pinning the socket for the life of the process.
   */
  release(reason: string): void {
    if (this.openCount === 0) return;
    this.openCount--;
    if (this.openCount === 0) this.close(reason);
  }

  /**
   * Drop the socket and evict this transport from the cache. Terminal, not a
   * pause: the instance stays closed and a later `openWsChannel` for the same
   * run constructs a fresh one. Idempotent. Safe with work in flight: those
   * requests fail through the socket's own `close` handler, same as any other
   * close.
   */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.openCount = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (wsState.transports.get(this.wsUrl) === this) {
      wsState.transports.delete(this.wsUrl);
    }
    const conn = this.connection;
    this.connection = null;
    // Normal closure: a clean client-side release, not an aborted run.
    conn?.ws.close(1000, reason);
  }

  /**
   * Whether a write can go out *now*, without waiting on a handshake.
   *
   * This is deliberately narrower than "does this run have a channel". The
   * write path uses it to decide between the socket and HTTP, and the honest
   * answer during a connect is HTTP: measured on a WS-enabled deployment,
   * `run_started` — the one write that routinely lands mid-handshake — cost
   * p50 269ms / p95 3.77s over the socket against p50 79ms / p95 134ms when it
   * fell back, while every write issued after the socket was up cost ~65ms.
   * Waiting for the handshake made the first write of a run slower than not
   * using the socket at all.
   *
   * A reconnect reads as not-ready for the same reason: the frames that would
   * queue behind it are better served by the transport that needs no setup.
   */
  get isReadyForWrites(): boolean {
    return this.connection?.ws.readyState === WebSocket.OPEN;
  }

  private ensureConnected(): Promise<Connection> {
    const conn = this.connection;
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(conn);
    }
    // Clearing the slot here rather than from the socket handlers keeps the
    // bookkeeping in one place, and stops a stale socket's late `close` from
    // nulling out a newer connect that has since taken the slot.
    this.connecting ??= this.connectWithSpan().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Resolve the headers for one upgrade request, once per socket, since the
   * bearer only rides the upgrade. Re-resolving per socket is what lets a
   * reconnect pick up a fresh token rather than replaying an expired one.
   *
   * Also the only place this transport can carry W3C trace context, which
   * `CLAUDE.md` requires of every outgoing world-vercel request: frames are not
   * HTTP requests and carry no headers of their own, so the server parents its
   * event spans to whichever invocation opened the socket rather than to the
   * individual write.
   */
  private async resolveUpgradeHeaders(): Promise<Record<string, string>> {
    const forceRefresh = this.needsFreshToken;
    const headers = await this.getHeaders({ forceRefresh });
    const authorization = readAuthorization(headers);

    if (forceRefresh && authorization === this.lastAuthorization) {
      // The server says the token is expiring and we can't produce a different
      // one. Inside a Vercel function the bearer comes from the invocation's own
      // `x-vercel-oidc-token` and is fixed for that invocation, so reconnecting
      // now earns a 401 and burns the attempt budget. Give up on the eager
      // reconnect; queue redelivery recovers this by landing in a new
      // invocation with a new token.
      throw new WsTransportError(
        `workflow-server events WS connection to ${this.wsUrl} drained for ` +
          `auth expiry, but re-resolving the bearer produced the same token. ` +
          `Not reconnecting with a token the server has already rejected; ` +
          `the next event write will retry.`
      );
    }

    this.lastAuthorization = authorization;
    this.needsFreshToken = false;

    // `injectTraceContextIntoHeaders` writes into a `Headers`; the upgrade takes
    // a plain record, so carry the propagator's output across. No-op when no
    // OTEL SDK is registered.
    const carrier = new Headers();
    await injectTraceContextIntoHeaders(carrier);
    carrier.forEach((value, key) => {
      headers[key] = value;
    });

    return headers;
  }

  private consumeDrainReason(): void {
    const reason = this.lastDrainReason;
    this.lastDrainReason = null;
    if (reason === 'auth_expiry') this.needsFreshToken = true;
  }

  /**
   * The handshake, wrapped in its own CLIENT span.
   *
   * The upgrade is the one genuinely-HTTP request this transport makes, and
   * until it had a span it was the invisible half of every WS write's latency:
   * a write that waits on a handshake shows the wait inside its own span with
   * nothing to attribute it to, and an eager reconnect between two writes shows
   * up nowhere at all. Named for the operation rather than `http GET` so it
   * doesn't land in the same bucket as the event writes it enables.
   *
   * It also puts `resolveUpgradeHeaders`' trace-context injection inside a
   * client span, matching `makeRequest`'s contract (CLAUDE.md): the server's
   * per-event spans parent to *this* span rather than directly to whichever
   * invocation happened to open the socket, so the handshake and everything the
   * server does over the connection hang together.
   */
  private connectWithSpan(): Promise<Connection> {
    return withHttpClientSpan(
      {
        method: 'GET',
        url: this.wsUrl,
        spanName: 'workflow.events.ws.connect',
        attributes: {
          ...WorkflowEventsTransport('ws'),
          ...NetworkProtocolName('websocket'),
          ...WorkflowWsReconnectAttempt(this.reconnectAttempts),
        },
      },
      async (span) => {
        try {
          return await this.connect();
        } catch (err) {
          span?.setAttributes({ ...ErrorType('TRANSPORT') });
          if (err instanceof Error) span?.recordException?.(err);
          throw err;
        }
      }
    );
  }

  private connect(): Promise<Connection> {
    return new Promise<Connection>((resolve, reject) => {
      void (async () => {
        let conn: Connection;
        try {
          const headers = await this.resolveUpgradeHeaders();
          const ws = new WebSocket(this.wsUrl, { headers });
          ws.binaryType = 'nodebuffer';
          conn = { ws, nextReqId: 1, pending: new Map() };
        } catch (err) {
          console.error(
            `world-vercel: ws events transport could not open a connection ` +
              `to ${this.wsUrl}: ${describeError(err)}`
          );
          // Nothing was sent, so re-sending is safe wherever the shared policy
          // allows it. Already-typed errors pass through untouched.
          reject(
            err instanceof WsTransportError
              ? err
              : new WsTransportError(
                  `workflow-server events WS connection to ${this.wsUrl} ` +
                    `could not be opened: ${describeError(err)}`,
                  { cause: err }
                )
          );
          return;
        }

        const { ws } = conn;
        let opened = false;

        ws.on('open', () => {
          opened = true;
          if (this.closed) {
            // Released while this handshake was in flight: `close()` could
            // only null out the connection it could see. Adopting this one now
            // would leave a live socket on a transport nothing will ever close.
            ws.close(1000, 'released while connecting');
            reject(
              new WsTransportError(
                `workflow-server events WS connection to ${this.wsUrl} was ` +
                  `released while connecting`
              )
            );
            return;
          }
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
          // `ws` normally follows `'error'` with `'close'`, which tears down and
          // schedules the reconnect. Close explicitly in case it doesn't.
          ws.close();
        });

        ws.on('close', (code: number) => {
          const wasActive = this.connection === conn;
          if (wasActive) this.connection = null;

          this.consumeDrainReason();

          if (!opened) {
            // A close with no preceding `'error'` would leave `ensureConnected`
            // waiting forever. Rejecting an already-settled promise is a no-op.
            reject(
              new WsTransportError(
                `workflow-server events WS connection to ${this.wsUrl} ` +
                  `closed before opening (code ${code})`
              )
            );
          }

          // Unconditional because `pending` is per-connection: a superseded
          // socket's late close can only reach its own waiters. The frame was
          // in flight when the socket died, so the server either never saw it
          // or never acked it, so re-sending is safe, createEvent writes are
          // conditional on the entity server-side.
          this.failAllPending(
            conn,
            new WsTransportError(
              `workflow-server events WS connection closed (code ${code})`
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
   * Reconnect eagerly rather than waiting for the next write: an unexpected
   * close mid-run (broken pipe, or the server's drain → 1001) almost always
   * means more writes are coming, and paying the handshake now keeps it off the
   * next write's critical path.
   */
  private scheduleReconnect(closeCode: number): void {
    // An intentional teardown lands here via the socket's own `close` event;
    // without this guard the transport would reconnect what it just released.
    if (this.closed) return;
    // A newer socket is already live. Deliberately not also checking
    // `this.connecting`: `ws` can emit `'error'` and `'close'` in one tick, so
    // that slot may not be cleared yet and bailing would break the retry
    // chain. `ensureConnected` dedups, so at worst the timer joins a connect
    // already in flight.
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
      void this.ensureConnected().catch(() => {});
    }, delayMs);
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
      // Uncorrelatable, and it says the framing on this socket is no longer
      // trustworthy, so the connection goes rather than leaving its waiters
      // unanswerable.
      const detail =
        `could not decode a ${raw.byteLength}-byte reply frame from ` +
        `${this.wsUrl}: ${describeError(err)}`;
      console.error(`world-vercel: ws events transport ${detail}`);
      this.failConnection(
        conn,
        `workflow-server events WS transport ${detail}`
      );
      return;
    }

    if (decoded.meta.type === 'drain') {
      // Unsolicited server push, no reqId. Informational on its own: the
      // `close` that follows is what triggers the reconnect and consumes the
      // reason recorded here.
      const reason: DrainReason =
        decoded.meta.reason === 'auth_expiry' ? 'auth_expiry' : 'max_duration';
      this.lastDrainReason = reason;
      console.log(
        `world-vercel: ws events transport received a drain notice ` +
          `(reason: ${reason}, graceMs: ${decoded.meta.graceMs ?? 'unspecified'}); ` +
          `connection will close soon.`
      );
      return;
    }

    const reqId = decoded.meta.reqId;

    if (reqId === MALFORMED_FRAME_REQ_ID) {
      // Loud: the server's schema rejected a frame this client sent, which is a
      // protocol bug on our side, not a transient failure. Nothing to correlate
      // it to by construction.
      const detail =
        `received a malformed-frame error from ${this.wsUrl} (reserved reqId ` +
        `${MALFORMED_FRAME_REQ_ID}, status ` +
        `${String(decoded.meta.status ?? 'unknown')}): ` +
        `${errorFrameMessage(decoded.body)}. The server could not parse a ` +
        `frame this client sent, so the originating write cannot be identified`;
      console.error(`world-vercel: ws events transport ${detail}.`);
      this.failConnection(
        conn,
        `workflow-server events WS transport ${detail}`
      );
      return;
    }

    if (typeof reqId !== 'number') {
      const detail =
        `received a reply frame with no numeric reqId from ${this.wsUrl} ` +
        `(type: ${String(decoded.meta.type ?? 'absent')})`;
      console.error(`world-vercel: ws events transport ${detail}.`);
      this.failConnection(
        conn,
        `workflow-server events WS transport ${detail}`
      );
      return;
    }

    const pending = conn.pending.get(reqId);
    if (!pending) {
      // The one uncorrelatable case that does NOT tear the connection down: an
      // id nobody is waiting on means that request already settled (send error,
      // or its own deadline with the reply arriving late). Nothing is orphaned,
      // and the frame decoded with a real reqId, so the stream is intact.
      console.error(
        `world-vercel: ws events transport received a reply for unknown ` +
          `reqId ${reqId} from ${this.wsUrl} (already settled, or the request ` +
          `was failed by a send error or its deadline); dropping it.`
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

  /**
   * Fail every waiter on `conn` and drop the socket, for a reply that can't be
   * correlated to a caller, and for a request that outlived its deadline. The
   * whole connection goes because each case says the stream itself is no longer
   * understood; logging and moving on would leave the originating request in
   * `pending` with nothing able to answer it until the server drains (~680s),
   * well past the waiting invocation's `maxDuration`. The socket's own `close`
   * handler does the teardown and schedules the reconnect; failing the waiters
   * here is what makes callers see this diagnosis, not a bare close code.
   */
  private failConnection(conn: Connection, message: string): void {
    this.failAllPending(conn, new WsTransportError(message));
    if (this.connection === conn) this.connection = null;
    conn.ws.close();
  }
}

/**
 * Process-wide, not module-scope: `@workflow/world-vercel` is bundled into the
 * Next.js server output, so a plain `const` here would be one Map per bundler
 * layer. The queue consumer registers a channel from the `instrument` layer
 * copy and the write path looks it up from the route layer copy: a
 * deterministic miss that silently demotes every event to HTTP. See
 * `globalSingleton`'s doc comment.
 *
 * `loggedWsProxyFallback` / `loggedWsInUse` live here for the same reason:
 * they are once-*per-process* latches, and a `let` cannot be shared by
 * reference.
 * Both branches they guard repeat on every event, so a per-copy log would be
 * the same noise the latch exists to prevent.
 */
const wsState = globalSingleton(
  // Keyed by package version, unlike the state that holds only plain data.
  // Two different published versions of this package can share one process (a
  // transitive dependency pinning an older `@workflow/core`, which depends on
  // this package by exact version), and this Map holds `WsEventsTransport`
  // instances. An unversioned key would hand one version's write path an object
  // built by the other version's class, and `events-v4.ts` would then frame and
  // parse against a protocol the other copy may not share. There is no version
  // negotiation on this socket to catch that. `shapeVersion` cannot express it:
  // the container shape is stable, the hazard is in the contents. Two versions
  // therefore keep separate registries, which costs a second socket and is what
  // happened before this package was bundled anyway.
  `@workflow/world-vercel//wsEventsTransports@${version}`,
  1,
  () => ({
    transports: new Map<string, WsEventsTransport>(),
    loggedWsProxyFallback: false,
    loggedWsInUse: false,
  })
);

/**
 * Get (or lazily create) the shared WS transport for `wsUrl`. `getHeaders` runs
 * once per socket, at connect time, with `forceRefresh: true` when the previous
 * socket drained on an expiring token, so a caching token source knows not to
 * serve the stale entry. Only the first caller's thunk for a `wsUrl` is kept,
 * which is fine, since `wsUrl` embeds the runId and one run has one client. An
 * entry exists only between `openWsChannel` and the matching `closeWsChannel`,
 * so membership *is* the answer to "does this run have a channel", which is
 * what the write path asks, via `resolveWsTransport`.
 */
export function getWsEventsTransport(
  wsUrl: string,
  getHeaders: (opts: {
    forceRefresh: boolean;
  }) => Promise<Record<string, string>>
): WsEventsTransport {
  let transport = wsState.transports.get(wsUrl);
  if (!transport) {
    transport = new WsEventsTransport(wsUrl, getHeaders);
    wsState.transports.set(wsUrl, transport);
  }
  return transport;
}

/**
 * Test seam: close and drop every cached transport, and re-arm the
 * once-per-process log latches below so a test asserting on either message
 * isn't silenced by an earlier one having already logged it.
 */
export function resetWsEventsTransportsForTest(): void {
  for (const transport of [...wsState.transports.values()]) {
    transport.close('test reset');
  }
  wsState.transports.clear();
  wsState.loggedWsProxyFallback = false;
  wsState.loggedWsInUse = false;
}

/**
 * Derive the WS endpoint URL for one run from the http(s) base URL used for v4
 * REST calls. `/websockets/v1/runs/:runId` is versioned independently of the
 * `v4` REST API these frames are forwarded into (server `docs/ws-protocol.md`).
 * Scoped to one run because one client instance only ever drives one run, so
 * `runId` belongs on the connection rather than on every frame.
 */
export function toEventsWsUrl(baseUrl: string, runId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/websockets/v1/runs/${encodeURIComponent(runId)}`;
  return url.toString();
}

// =============================================================================
// Transport selection
// =============================================================================

/**
 * Re-exported so this module stays the single seam for everything socket-shaped.
 * Import it from `./ws-transport-enabled.js` instead when the point is to *not*
 * load this module.
 */
export { isWsEventsTransportEnabled };

/**
 * Open this run's events channel for the duration of one invocation, start
 * connecting, and return the release for that claim. Nothing else creates a
 * channel, so a code path that doesn't call this writes its events over HTTP
 * even with the transport enabled.
 *
 * Call it as early in an invocation as the run id is known, as the flow route
 * does before dispatching to the runtime. Only worth it for a caller that will
 * write
 * several events: a single write does not repay a handshake, which is why
 * `start()` deliberately doesn't open one for `run_created`.
 *
 * Silent and synchronous by contract: `undefined` on the HTTP default and on a
 * World that can't hold a socket, and it neither awaits nor reports the
 * connect. Callers must be able to treat it as free.
 *
 * An open socket is not `unref`'d, so a caller that drops the release stops the
 * process exiting (and keeps a server invocation pinned, one per connection)
 * until the platform kills it. The socket drops once every concurrent holder
 * has released; see `WsEventsTransport.release`.
 *
 * **The release closes over the instance, never the URL.** A channel is evicted
 * from `transports` the moment it closes, and a refused upgrade does that on
 * the connect path, so the next opener for the same run gets a *different*
 * instance under the same URL. A release that re-resolved the URL would
 * decrement whichever instance is registered by then rather than the one it
 * claimed, dropping a socket a live invocation is still writing over, and for
 * the event types `EVENT_RETRY_ELIGIBILITY` marks non-retryable there is no
 * second attempt to carry that write over HTTP. Idempotent for the same reason:
 * a doubled release must not consume another holder's claim.
 *
 * Synchronous matters beyond cost. Two invocations for one run share a channel,
 * so an open races a release whenever the refcount stands at 1, and because
 * neither yields between its map lookup and its refcount write, the release
 * either observes the open's increment, and the socket survives for the new
 * holder, or lands first, and the opener misses the de-registered instance and
 * builds a fresh channel. Adding an await ahead of the refcount write (minting
 * a token to derive the URL, say) reopens that window, and an open landing
 * inside it hits an already-closed instance, returns early, and leaves that
 * invocation on HTTP for its whole duration with nothing to signal it.
 */
export function openWsChannel(
  runId: string,
  config?: APIConfig
): (() => void) | undefined {
  if (!isWsEventsTransportEnabled()) return undefined;
  const resolved = resolveChannelUrl(runId, config);
  if (!resolved) return undefined;
  if (!wsState.loggedWsInUse) {
    wsState.loggedWsInUse = true;
    console.log(`world-vercel: using ws events transport (${resolved}).`);
  }
  // Cheap: a URL plus a map lookup, no token mint and no I/O. The socket work
  // happens inside `open`, unawaited.
  const transport = getWsEventsTransport(resolved, async ({ forceRefresh }) => {
    // `forceRefresh` means the previous socket was drained by the server
    // because its *bearer* was expiring, not because the socket aged out.
    if (forceRefresh) await refreshOidcTokenBestEffort();
    const { headers } = await getHttpConfig(config);
    return headersToRecord(headers);
  });
  transport.open();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    transport.release('invocation complete');
  };
}

/**
 * A buffer wider than any OIDC token's lifetime, so `isExpired()` reports
 * true and `@vercel/oidc` takes its refresh path instead of handing back the
 * cached entry. 24h comfortably exceeds the 60min TTL.
 */
const OIDC_FORCE_REFRESH_BUFFER_MS = 24 * 60 * 60 * 1000;

/**
 * Ask `@vercel/oidc` for a new token before the next `getHttpConfig()` reads
 * one, in response to a drain with `reason: 'auth_expiry'`. Swallows failures:
 * an unavailable refresh must not fail a write that `getHttpConfig()` can still
 * produce a usable (if soon-to-expire) bearer for.
 *
 * Only effective outside a Vercel function. `getVercelOidcToken()` prefers
 * `getContext().headers['x-vercel-oidc-token']` over
 * `process.env.VERCEL_OIDC_TOKEN`, and the refresh only writes the env var, so
 * inside a function the invocation's own header token shadows anything minted
 * here and there is genuinely no fresher bearer mid-invocation. The transport's
 * stale-token guard covers that case instead. In a CLI, local dev or a
 * long-lived server there is no context header and the reconnect picks up the
 * new token.
 */
async function refreshOidcTokenBestEffort(): Promise<void> {
  try {
    await getVercelOidcToken({
      expirationBufferMs: OIDC_FORCE_REFRESH_BUFFER_MS,
    });
  } catch {
    // No refresh path available here. getHttpConfig() below still resolves
    // whatever token it can, and the transport decides whether reconnecting
    // with it is worth attempting.
  }
}

/**
 * Resolve this run's channel URL, or `null` when this World can't hold a socket
 * at all and every caller must use HTTP. Says nothing about whether a channel is
 * *open*; that's `resolveWsTransport`.
 */
function resolveChannelUrl(
  runId: string,
  config: APIConfig | undefined
): string | null {
  // `getHttpUrl` is the cheap, synchronous half of `getHttpConfig`: it resolves
  // the route without minting a token. The bearer only rides the upgrade, so
  // the transport resolves it once per socket instead of once per write.
  const { baseUrl, usingProxy } = getHttpUrl(config);
  if (usingProxy) {
    // `usingProxy` resolves `baseUrl` to `api.vercel.com/v1/workflow`, an
    // HTTP-only REST gateway that does not forward a raw WebSocket upgrade to
    // the workflow-server target: it either rejects the upgrade or hands the
    // route a plain forwarded request that never went through Vercel's
    // platform-level upgrade path, which is what surfaces as
    // "experimental_upgradeWebSocket is not available in the current runtime
    // environment". Fall back rather than fail a connection it can't serve.
    if (!wsState.loggedWsProxyFallback) {
      wsState.loggedWsProxyFallback = true;
      console.warn(
        `world-vercel: ws events transport requested but a World with projectConfig ` +
          `(api-workflow proxy, resolved baseUrl: ${baseUrl}) is active — falling back.`
      );
    }
    return null;
  }
  return toEventsWsUrl(baseUrl, runId);
}

/**
 * The write path's question: is there an open channel for this run? `null` means
 * write over HTTP, because the transport is disabled, because this World can't
 * hold a socket, or because nothing opened a channel for this invocation.
 *
 * A lookup, never a create. Lazily connecting here is what made the socket's
 * lifetime a property of the *last write* rather than of the caller, and left a
 * timer as the only thing able to end it.
 */
export function resolveWsTransport(
  runId: string,
  config: APIConfig | undefined
): {
  transport: WsEventsTransport;
  wsUrl: string;
} | null {
  const wsUrl = resolveChannelUrl(runId, config);
  if (!wsUrl) return null;
  const transport = wsState.transports.get(wsUrl);
  // Membership answers "does this run have a channel"; `isReadyForWrites` adds
  // "and can it take a frame without a handshake first". Both have to hold:
  // see the getter for why a mid-connect write is better off on HTTP.
  if (!transport || !transport.isReadyForWrites) return null;
  return { transport, wsUrl };
}
