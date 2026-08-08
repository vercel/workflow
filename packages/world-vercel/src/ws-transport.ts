/**
 * WebSocket transport for v4 event POSTs (POC — see workflow-architecture.md
 * notes on the http→ws exploration).
 *
 * One physical socket per (wsUrl) is kept open and shared across concurrent
 * `createWorkflowRunEventV4` calls. Each logical request gets a `reqId`
 * embedded in the outgoing frame's CBOR meta (by the caller, before
 * `encodeFrame`); replies are matched back to their caller via the same
 * `reqId` echoed in the reply frame's meta. This mirrors the multiplexing
 * pattern already proven in the echo-bench `WsProxy`
 * (nextjs-app-1/app/echobench/ws-proxy.ts): lazy/shared connect, one socket,
 * many in-flight requests keyed by id.
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
        if (this.ws === ws) this.ws = null;
        this.connecting = null;
        this.failAllPending(
          new Error('workflow-server events WS connection closed')
        );
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

/** Derive the events WS URL from the (http/https) base URL used for v4 REST calls. */
export function toEventsWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v4/events/ws`;
  return url.toString();
}

/**
 * TEMP test-only helper: open a bare `ws` connection with custom headers
 * (needed for the OIDC/trusted-sources handshake, same reason as
 * `WsEventsTransport` above) and collect every text message it receives
 * until the socket closes. No framing, no multiplexing — just enough to
 * smoke-test that a raw WebSocket upgrade against a deployment works.
 * Exists to debug the http->ws exploration; remove once that's settled.
 */
export function collectWsMessages(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`collectWsMessages: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on('message', (data) => messages.push(data.toString()));
    ws.on('close', () => {
      clearTimeout(timer);
      resolve(messages);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
