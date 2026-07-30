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
 * The server can also push an unsolicited `type: 'drain'` frame (no
 * `reqId`, since it isn't a reply to anything) announcing the connection
 * is closing soon ahead of its `maxDuration`. This file currently only
 * logs it — there's no reconnect-before-close handling yet, so in-flight
 * requests at drain time still fail the same way they would on an
 * unannounced close. See the server spec's "known limitations" for the
 * client-side reconnect work this is waiting on.
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

interface PendingRequest {
  resolve: (reply: WsFrameReply) => void;
  reject: (err: unknown) => void;
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

/**
 * One multiplexed connection to the events WS endpoint. Not exported —
 * callers go through `getWsEventsTransport`, which caches one instance per
 * `wsUrl` for the lifetime of the process (a POC simplification; a real
 * implementation would key on the auth/tenant headers too, since those are
 * bound at connect time rather than resent per message).
 */
class WsEventsTransport {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextReqId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly wsUrl: string,
    private readonly headers: Record<string, string>
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
    const ws =
      this.ws && this.ws.readyState === WebSocket.OPEN
        ? this.ws
        : await this.ensureConnected();

    const reqId = this.nextReqId++;
    const frame = buildFrame(reqId);
    return new Promise<WsFrameReply>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      ws.send(frame);
    });
  }

  private ensureConnected(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.ws);
    }
    this.connecting ??= this.connect();
    return this.connecting;
  }

  private connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { headers: this.headers });
      ws.binaryType = 'nodebuffer';

      ws.on('open', () => {
        this.ws = ws;
        this.connecting = null;
        resolve(ws);
      });

      ws.on('message', (raw: Buffer) => {
        void this.handleMessage(new Uint8Array(raw));
      });

      ws.on('error', (err) => {
        this.connecting = null;
        reject(err);
      });

      ws.on('close', () => {
        // Guard against a superseded socket's late `close` firing after a
        // newer socket has already taken over `this.ws` — only the still-
        // active socket's close should fail pending requests, otherwise
        // in-flight requests riding the new socket get spuriously rejected.
        const wasActive = this.ws === ws;
        if (wasActive) this.ws = null;
        this.connecting = null;
        if (wasActive) {
          this.failAllPending(
            new Error('workflow-server events WS connection closed')
          );
        }
      });
    });
  }

  private async handleMessage(raw: Uint8Array): Promise<void> {
    let decoded: DecodedFrame;
    try {
      decoded = await decodeOneFrame(raw);
    } catch {
      return;
    }
    if (decoded.meta.type === 'drain') {
      // Unsolicited server push, no reqId — the connection is closing soon
      // ahead of its maxDuration. No reconnect-before-close handling yet
      // (see the class doc), so this is purely informational for now: any
      // request still in flight when the close actually happens fails the
      // same way it would on an unannounced close.
      console.log(
        `world-vercel: ws events transport received a drain notice ` +
          `(graceMs: ${decoded.meta.graceMs ?? 'unspecified'}); connection will close soon.`
      );
      return;
    }
    const reqId = decoded.meta.reqId;
    if (typeof reqId !== 'number') return;
    const pending = this.pending.get(reqId);
    if (!pending) return;
    this.pending.delete(reqId);
    pending.resolve({ meta: decoded.meta, body: decoded.body });
  }

  private failAllPending(err: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}

const transports = new Map<string, WsEventsTransport>();

/**
 * Get (or lazily create) the shared WS transport for `wsUrl`. `headers` are
 * only used the first time a given `wsUrl` connects (they're sent once, on
 * the upgrade request) — see the class doc for the multi-tenant caveat.
 */
export function getWsEventsTransport(
  wsUrl: string,
  headers: Record<string, string>
): WsEventsTransport {
  let transport = transports.get(wsUrl);
  if (!transport) {
    transport = new WsEventsTransport(wsUrl, headers);
    transports.set(wsUrl, transport);
  }
  return transport;
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
