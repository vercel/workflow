/**
 * Client half of the events WebSocket protocol. The normative wire-format and
 * lifecycle spec is the server's `docs/ws-protocol.md`.
 *
 * One socket per `wsUrl` — which embeds the runId — is shared across concurrent
 * `createWorkflowRunEventV4` calls and multiplexed by `reqId`. Frame meta is
 * `{ reqId, type, ... }`, with the type-specific payload nested under a field
 * named after `type` (only `event` is sent today). The caller builds the meta;
 * this file owns the socket and the reqId<->promise bookkeeping.
 *
 * Every failure mode has to reach the caller waiting on it — a swallowed error
 * here is a hung invocation, not a lost log line. Whether a failed write is
 * re-sent is `event-retry.ts`'s decision, not this file's: `WsTransportError`
 * is mapped to the same `code: 'TRANSPORT'` shape a failed `fetch` produces.
 *
 * Uses the `ws` package rather than the WHATWG global `WebSocket`, which cannot
 * set headers on the upgrade request — auth rides the handshake, once per
 * connection instead of once per message.
 *
 * Transport *selection* lives at the bottom of the file — the opt-in flag,
 * which Worlds can hold a socket at all, and the pre-warm entry point — so
 * `events-v4.ts` consumes one seam instead of assembling the transport.
 */

import { getVercelOidcToken } from '@vercel/oidc';
import { WebSocket } from 'ws';
import { type DecodedFrame, decodeFrames } from './frames.js';
import { getRequestTimeoutMs, headersToRecord } from './http-core.js';
import { type APIConfig, getHttpConfig, getHttpUrl } from './utils.js';

export interface WsFrameReply {
  meta: Record<string, unknown>;
  body: Uint8Array;
}

/**
 * A transport-level failure: the socket closed, the frame could not be handed
 * to it, or a reply arrived that cannot be correlated to a caller — always
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

/**
 * How long a transport may sit with nothing in flight before dropping its
 * socket and evicting itself from the cache. The server pins one invocation per
 * connection and eager reconnect renews a connection indefinitely, so without
 * this a warm container holds a socket — and a live server invocation — for
 * every run it has served. Idleness is the only available trigger: the events
 * adapter is a stateless per-write call with no "run complete" signal.
 *
 * Below the server's drain deadline (~680s) so the client normally releases
 * first, and well above the gap between steps of an active run.
 */
const IDLE_TIMEOUT_MS = 60_000;

/** Absent on servers predating the field, which only ever drained for
 *  maxDuration — so absent reads as `max_duration`. */
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
 * One multiplexed connection to the events WS endpoint. Not exported — callers
 * go through `getWsEventsTransport`, which caches one instance per `wsUrl`.
 */
class WsEventsTransport {
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  /** Set by `close()`. Suppresses reconnects so an intentional teardown can't
   *  be undone by the close handler it triggers. */
  private closed = false;
  /** Reason from the most recent `drain`, consumed by the close that follows. */
  private lastDrainReason: DrainReason | null = null;
  /** A drain said the *token* expired, not that the socket aged out — the next
   *  connect must not reuse the same bearer. */
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
    this.cancelIdleTimer();
    if (this.closed) {
      // A caller holding a reference to an idle-closed transport. Revive it
      // rather than failing the write, re-registering only if nothing else has
      // claimed the slot meanwhile (a newer instance must win).
      this.closed = false;
      if (!transports.has(this.wsUrl)) transports.set(this.wsUrl, this);
    }
    this.inFlight++;
    try {
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
          // SIGTERM — including a server that accepts a frame and never
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
            // `ws.send()` does not throw when the socket isn't OPEN — it
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
    } finally {
      this.inFlight--;
      this.armIdleTimer();
    }
  }

  /**
   * Open the socket ahead of the first write. Connecting lazily instead bills
   * the handshake (plus the OIDC mint riding it) to whichever event is written
   * first; when that's a `step_started` issued as the step body already runs,
   * its server-recorded timestamp lands after the work it timestamps and the
   * step reads as shorter than it was.
   *
   * Fire-and-forget and idempotent: a failed warm logs in `connect` and
   * schedules no reconnect, leaving the first write to connect as it would
   * have. Arms the idle timer as if a request had settled, so a warmed socket
   * whose invocation never writes is still released — it isn't `unref`'d, and a
   * leaked one keeps both this process and a server invocation alive.
   */
  warm(): void {
    if (this.closed) return;
    if (this.connection !== null || this.connecting !== null) return;
    // Errors are logged by `connect`; swallow so an unawaited warm can't
    // surface as an unhandled rejection.
    void this.ensureConnected().catch(() => {});
    this.armIdleTimer();
  }

  /**
   * Drop the socket and evict this transport from the cache. Idempotent. Safe
   * with work in flight — those requests fail through the socket's own `close`
   * handler, same as any other close.
   */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelIdleTimer();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (transports.get(this.wsUrl) === this) transports.delete(this.wsUrl);
    const conn = this.connection;
    this.connection = null;
    // Normal closure: a clean client-side release, not an aborted run.
    conn?.ws.close(1000, reason);
  }

  private armIdleTimer(): void {
    if (this.closed || this.inFlight > 0 || this.idleTimer !== null) return;
    const timer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inFlight > 0) return;
      this.close('idle');
    }, IDLE_TIMEOUT_MS);
    // Never hold the event loop open just to wait out a timer — as with the
    // reconnect backoff and the request deadline.
    timer.unref?.();
    this.idleTimer = timer;
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private ensureConnected(): Promise<Connection> {
    const conn = this.connection;
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(conn);
    }
    // Clearing the slot here rather than from the socket handlers keeps the
    // bookkeeping in one place, and stops a stale socket's late `close` from
    // nulling out a newer connect that has since taken the slot.
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Resolve the headers for one upgrade request — once per socket, since the
   * bearer only rides the upgrade. Re-resolving per socket is what lets a
   * reconnect pick up a fresh token rather than replaying an expired one.
   */
  private async resolveUpgradeHeaders(): Promise<Record<string, string>> {
    const forceRefresh = this.needsFreshToken;
    const headers = await this.getHeaders({ forceRefresh });
    const authorization = readAuthorization(headers);

    if (forceRefresh && authorization === this.lastAuthorization) {
      // The server says the token is expiring and we can't produce a different
      // one. Inside a Vercel function the bearer comes from the invocation's own
      // `x-vercel-oidc-token` and is fixed for that invocation, so reconnecting
      // now just earns a 401 and burns the attempt budget. Give up on the eager
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
    return headers;
  }

  private consumeDrainReason(): void {
    const reason = this.lastDrainReason;
    this.lastDrainReason = null;
    if (reason === 'auth_expiry') this.needsFreshToken = true;
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
            // Released while this handshake was in flight — `close()` could
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
          // or never acked it — re-sending is safe, createEvent writes are
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
      // trustworthy — so the connection goes rather than leaving its waiters
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
      // Unsolicited server push, no reqId. Informational on its own — the
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
   * Fail every waiter on `conn` and drop the socket — for a reply that can't be
   * correlated to a caller, and for a request that outlived its deadline. The
   * whole connection goes because each case says the stream itself is no longer
   * understood; logging and moving on would leave the originating request in
   * `pending` with nothing able to answer it until the server drains (~680s),
   * well past the waiting invocation's `maxDuration`. The socket's own `close`
   * handler does the teardown and schedules the reconnect — failing the waiters
   * here is what makes callers see this diagnosis, not a bare close code.
   */
  private failConnection(conn: Connection, message: string): void {
    this.failAllPending(conn, new WsTransportError(message));
    if (this.connection === conn) this.connection = null;
    conn.ws.close();
  }
}

const transports = new Map<string, WsEventsTransport>();

/**
 * Get (or lazily create) the shared WS transport for `wsUrl`. `getHeaders` runs
 * once per socket, at connect time, with `forceRefresh: true` when the previous
 * socket drained on an expiring token, so a caching token source knows not to
 * serve the stale entry. Only the first caller's thunk for a `wsUrl` is kept —
 * fine, since `wsUrl` embeds the runId and one run has one client. Entries
 * evict themselves after `IDLE_TIMEOUT_MS`, so this map tracks active runs.
 */
export function getWsEventsTransport(
  wsUrl: string,
  getHeaders: (opts: {
    forceRefresh: boolean;
  }) => Promise<Record<string, string>>
): WsEventsTransport {
  let transport = transports.get(wsUrl);
  if (!transport) {
    transport = new WsEventsTransport(wsUrl, getHeaders);
    transports.set(wsUrl, transport);
  }
  return transport;
}

/**
 * Test seam: close and drop every cached transport, and re-arm the
 * once-per-process log latches below so a test asserting on either message
 * isn't silenced by an earlier one having already logged it.
 */
export function resetWsEventsTransportsForTest(): void {
  for (const transport of [...transports.values()]) {
    transport.close('test reset');
  }
  transports.clear();
  loggedWsProxyFallback = false;
  loggedWsInUse = false;
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
 * The opt-in gate: HTTP unless `WORKFLOW_EVENTS_TRANSPORT=ws`. Only
 * `createWorkflowRunEventV4` (POST) is wired to it — GET/LIST aren't on the hot
 * per-step path, and LIST's streamed, sentinel-terminated multi-frame response
 * doesn't map onto a single WS message.
 *
 * **Known gap: WS writes carry no client-side instrumentation.** The HTTP
 * branch's `instrumentedFetch` opens the OTEL CLIENT span, injects trace
 * context, and routes through the global `fetch` that Vercel's
 * outgoing-requests view instruments (see the note on `fetchV4`); the WS branch
 * bypasses all of it, leaving the server's own transport-tagged request metrics
 * as the only signal. Acceptable behind a flag — instrumenting the transport is
 * a prerequisite for defaulting to it, not a follow-up.
 */
export function isWsEventsTransportEnabled(): boolean {
  return process.env.WORKFLOW_EVENTS_TRANSPORT === 'ws';
}

/**
 * Start opening this run's socket. Call it as early in an invocation as the run
 * id is known — the queue handler does, before dispatching to the runtime — so
 * the handshake is done or in flight by the first write rather than serialized
 * ahead of it (see `WsEventsTransport.warm`).
 *
 * Silent and synchronous by contract: a no-op on the HTTP default and on a
 * World that can't hold a socket, and it neither awaits nor reports the
 * connect. Callers must be able to treat it as free.
 */
export function warmWsEventsTransport(runId: string, config?: APIConfig): void {
  if (!isWsEventsTransportEnabled()) return;
  // Cheap: resolving is a URL plus a memoized lookup, no token mint and no
  // I/O. The socket work happens inside `warm`, unawaited.
  resolveWsTransport(runId, config)?.transport.warm();
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
 * produce a usable — if soon-to-expire — bearer for.
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

// Each logged at most once per process — both branches below are expected
// to repeat (every event), and a per-request log would just be noise.
let loggedWsProxyFallback = false;
let loggedWsInUse = false;

/**
 * Resolve the WS transport for a run, or `null` when this World can't use
 * one and the caller should fall back to HTTP.
 */
export function resolveWsTransport(
  runId: string,
  config: APIConfig | undefined
): {
  transport: WsEventsTransport;
  wsUrl: string;
} | null {
  // `getHttpUrl` is the cheap, synchronous half of `getHttpConfig`: it resolves
  // the route without minting a token. The bearer only rides the upgrade, so
  // the transport resolves it once per socket instead of once per write.
  const { baseUrl, usingProxy } = getHttpUrl(config);
  if (usingProxy) {
    // `usingProxy` resolves `baseUrl` to `api.vercel.com/v1/workflow`, an
    // HTTP-only REST gateway that does not forward a raw WebSocket upgrade to
    // the workflow-server target — it either rejects the upgrade or hands the
    // route a plain forwarded request that never went through Vercel's
    // platform-level upgrade path, which is what surfaces as
    // "experimental_upgradeWebSocket is not available in the current runtime
    // environment". Fall back rather than fail a connection it can't serve.
    if (!loggedWsProxyFallback) {
      loggedWsProxyFallback = true;
      console.warn(
        `world-vercel: ws events transport requested but a World with projectConfig ` +
          `(api-workflow proxy, resolved baseUrl: ${baseUrl}) is active — falling back.`
      );
    }
    return null;
  }
  if (!loggedWsInUse) {
    loggedWsInUse = true;
    console.log(
      `world-vercel: using ws events transport (baseUrl: ${baseUrl}).`
    );
  }
  const wsUrl = toEventsWsUrl(baseUrl, runId);
  const transport = getWsEventsTransport(wsUrl, async ({ forceRefresh }) => {
    // `forceRefresh` means the previous socket was drained by the server
    // because its *bearer* was expiring, not because the socket aged out.
    if (forceRefresh) await refreshOidcTokenBestEffort();
    const { headers } = await getHttpConfig(config);
    return headersToRecord(headers);
  });
  return { transport, wsUrl };
}
