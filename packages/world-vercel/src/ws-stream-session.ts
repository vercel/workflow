import type { StreamWriteSession } from '@workflow/world';
import type { WebSocket } from 'ws';
import { type DecodedFrame, decodeFrames } from './frames.js';
import {
  getRequestTimeoutMs,
  headersToRecord,
  withHttpClientSpan,
} from './http-core.js';
import {
  encodeStreamWsCloseRequest,
  encodeStreamWsWriteRequest,
  getStreamWsProtocolV1Url,
  parseStreamWsReply,
  STREAM_WS_V1_MAX_CHUNKS_PER_WRITE,
  type StreamWriterId,
  StreamWriterIdSchema,
} from './stream-ws-protocol-v1.js';
import { injectTraceContextIntoHeaders } from './telemetry.js';
import type { APIConfig } from './utils.js';
import { getHttpConfig } from './utils.js';
import {
  beginNormalWsClose,
  STREAM_WS_CONNECT_BUDGET_MS,
} from './ws-stream-connect.js';
import { isWsStreamsTransportEnabled } from './ws-transport-enabled.js';

type Mode = 'connecting' | 'ws' | 'http' | 'closed' | 'poisoned';
const MAX_IDLE_RECONNECTS = 3;

async function decodeOne(raw: Uint8Array): Promise<DecodedFrame> {
  let frame: DecodedFrame | undefined;
  for await (const candidate of decodeFrames(
    (async function* () {
      yield raw;
    })()
  )) {
    if (frame) throw new Error('stream WebSocket message has multiple frames');
    frame = candidate;
  }
  if (!frame) throw new Error('stream WebSocket message has no frame');
  return frame;
}

function asBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  return new Uint8Array(raw as ArrayBufferLike);
}

/**
 * One stateful stream-writer lifetime. Requests are deliberately serialized;
 * an unacknowledged frame has an unknown outcome and poisons the session rather
 * than being replayed over HTTP or another socket.
 */
class VercelStreamWriteSession implements StreamWriteSession {
  private mode: Mode = 'connecting';
  private socket: WebSocket | undefined;
  private connect: Promise<void>;
  private transportDecision: Promise<void>;
  private tail = Promise.resolve();
  private inbound = Promise.resolve();
  private nextReqId = 1;
  private pending:
    | {
        reqId: number;
        resolve: (meta: Record<string, unknown>) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private poisonError: unknown;
  private wsUrl: string | undefined;
  private closeAcknowledged = false;
  private idleReconnects = 0;

  constructor(
    private readonly runId: string,
    private readonly name: string,
    private readonly writerId: StreamWriterId,
    private readonly config: APIConfig | undefined,
    private readonly writeHttp: (
      chunks: (string | Uint8Array)[]
    ) => Promise<void>,
    private readonly closeHttp: () => Promise<void>
  ) {
    this.connect = this.startConnect();
    this.transportDecision = this.makeTransportDecision();
  }

  write(chunkSeq: number, chunks: (string | Uint8Array)[]): Promise<void> {
    return this.enqueue(async () => {
      this.assertUsable();
      await this.transportDecision;
      if (this.mode === 'http') {
        await this.writeHttp(chunks);
        return;
      }
      for (
        let offset = 0;
        offset < chunks.length;
        offset += STREAM_WS_V1_MAX_CHUNKS_PER_WRITE
      ) {
        const batch = chunks.slice(
          offset,
          offset + STREAM_WS_V1_MAX_CHUNKS_PER_WRITE
        );
        const reply = await this.request((reqId) =>
          encodeStreamWsWriteRequest(
            {
              type: 'write',
              reqId,
              chunkSeq: chunkSeq + offset,
              numChunks: batch.length,
            },
            batch
          )
        );
        if (reply.type !== 'write_ack') {
          throw this.poison(
            new Error(`stream WebSocket write received ${reply.type}`)
          );
        }
      }
    });
  }

  dispose(): void {
    if (this.mode === 'closed') return;
    this.mode = 'closed';
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('stream writer transport disposed'));
    }
    this.socket?.close(1000, 'stream writer disposed');
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      this.assertUsable();
      await this.transportDecision;
      if (this.mode === 'http') {
        await this.closeHttp();
        this.mode = 'closed';
        return;
      }
      const reply = await this.request((reqId) =>
        encodeStreamWsCloseRequest({ type: 'close', reqId })
      );
      if (reply.type !== 'close_ack') {
        throw this.poison(
          new Error(`stream WebSocket close received ${reply.type}`)
        );
      }
      this.mode = 'closed';
      if (this.socket) beginNormalWsClose(this.socket, 'stream closed');
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  private assertUsable(): void {
    if (this.mode === 'poisoned') throw this.poisonError;
    if (this.mode === 'closed') throw new Error('stream writer is closed');
  }

  /** One shared bounded decision for all operations queued while connecting. */
  private makeTransportDecision(): Promise<void> {
    return new Promise((resolve) => {
      let decided = false;
      const decide = () => {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (this.mode === 'connecting') {
          this.mode = 'http';
          this.socket?.close(1000, 'connect budget expired');
        }
        decide();
      }, STREAM_WS_CONNECT_BUDGET_MS);
      timer.unref?.();
      void this.connect.then(decide);
    });
  }

  private startConnect(): Promise<void> {
    return this.connectSocket().catch(() => {
      // Every failure before OPEN is a safe, session-long HTTP fallback. The
      // HTTP request itself still surfaces auth/configuration errors normally.
      if (this.mode === 'connecting') this.mode = 'http';
    });
  }

  private async connectSocket(): Promise<void> {
    if (!isWsStreamsTransportEnabled()) {
      this.mode = 'http';
      return;
    }
    const [{ WebSocket: WebSocketImpl }, http] = await Promise.all([
      import('ws'),
      getHttpConfig(this.config),
    ]);
    if (this.mode !== 'connecting') return;
    if (http.usingProxy) {
      this.mode = 'http';
      return;
    }
    if (this.mode !== 'connecting') return;
    const url = getStreamWsProtocolV1Url(
      http.baseUrl,
      this.runId,
      this.name,
      this.writerId
    );
    this.wsUrl = url.toString();
    await withHttpClientSpan(
      {
        method: 'GET',
        url: this.wsUrl,
        spanName: 'workflow.stream.ws.connect',
        attributes: { 'workflow.stream.transport': 'ws' },
      },
      async () => {
        await injectTraceContextIntoHeaders(http.headers);
        if (this.mode !== 'connecting') return;
        const ws = new WebSocketImpl(url, {
          headers: headersToRecord(http.headers),
        });
        this.socket = ws;
        ws.binaryType = 'nodebuffer';

        await new Promise<void>((resolve) => {
          let opened = false;
          const fallback = () => {
            if (opened) return;
            if (this.mode === 'connecting') this.mode = 'http';
            resolve();
          };
          ws.once('open', () => {
            opened = true;
            if (this.mode !== 'connecting') {
              ws.close(1000, 'HTTP fallback selected');
              resolve();
              return;
            }
            this.mode = 'ws';
            resolve();
          });
          ws.once('unexpected-response', (_request, response) => {
            // Listening transfers response cleanup responsibility from `ws`
            // to us. Drain when possible, then destroy the declined upgrade.
            const res = response as {
              resume?: () => void;
              destroy?: () => void;
            };
            res.resume?.();
            res.destroy?.();
            ws.close(1000, 'upgrade declined');
            fallback();
          });
          ws.once('error', (error) => {
            if (!opened) {
              fallback();
              return;
            }
            this.failUnknown(error);
          });
          ws.once('close', () => {
            if (!opened) {
              fallback();
              return;
            }
            // A server may queue close immediately after its terminal reply.
            // Let the already-delivered message finish decoding first.
            void this.inbound.then(() => this.handleSocketClose());
          });
          ws.on('message', (raw) => {
            this.inbound = this.inbound.then(() =>
              this.handleMessage(asBytes(raw))
            );
          });
        });
      }
    );
  }

  private async handleMessage(raw: Uint8Array): Promise<void> {
    try {
      const frame = await decodeOne(raw);
      const reply = parseStreamWsReply(frame.meta, frame.body);
      const pending = this.pending;
      if (
        !pending ||
        reply.reqId === undefined ||
        reply.reqId !== pending.reqId
      ) {
        throw new Error('stream WebSocket reply cannot be correlated');
      }
      this.pending = undefined;
      clearTimeout(pending.timer);
      if (reply.type === 'close_ack') this.closeAcknowledged = true;
      if (reply.type === 'error') {
        pending.reject(
          this.poison(
            new Error(
              `stream WebSocket request failed (${reply.status}): ${reply.message ?? 'unknown error'}`
            )
          )
        );
        this.socket?.close(1011, 'stream request failed');
      } else {
        pending.resolve(reply);
      }
    } catch (error) {
      this.failUnknown(error);
    }
  }

  private handleSocketClose(): void {
    if (
      this.mode === 'closed' ||
      this.mode === 'http' ||
      this.mode === 'poisoned' ||
      this.closeAcknowledged
    ) {
      return;
    }
    if (this.pending) {
      this.failUnknown(new Error('stream WebSocket closed before reply'));
      return;
    }
    // Clean idle infrastructure close: reconnect with the same writer identity
    // and next writer-local sequence, but cap eager attempts so a draining
    // server cannot create an open/close hot loop for the invocation lifetime.
    if (this.idleReconnects >= MAX_IDLE_RECONNECTS) {
      this.mode = 'http';
      this.socket = undefined;
      return;
    }
    this.idleReconnects++;
    this.mode = 'connecting';
    this.socket = undefined;
    this.connect = this.startConnect();
    this.transportDecision = this.makeTransportDecision();
  }

  private async request(
    buildFrame: (reqId: number) => Uint8Array
  ): Promise<Record<string, unknown>> {
    this.assertUsable();
    const ws = this.socket;
    if (this.mode !== 'ws' || !ws || ws.readyState !== 1) {
      throw this.poison(new Error('stream WebSocket is not open'));
    }
    const reqId = this.nextReqId++;
    let frame: Uint8Array;
    try {
      frame = buildFrame(reqId);
    } catch (error) {
      throw this.poison(error);
    }
    return withHttpClientSpan(
      {
        method: 'POST',
        url: this.wsUrl ?? 'ws://unknown',
        spanName: 'workflow.stream.write',
        attributes: {
          'workflow.stream.transport': 'ws',
          'workflow.stream.ws.req_id': reqId,
        },
      },
      async () =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.failUnknown(
              new Error(
                `stream WebSocket request ${reqId} timed out with no reply`
              )
            );
          }, getRequestTimeoutMs());
          timer.unref?.();
          this.pending = { reqId, resolve, reject, timer };
          try {
            ws.send(frame, (error) => {
              if (!error) return;
              this.failUnknown(error);
            });
          } catch (error) {
            this.failUnknown(error);
          }
        })
    );
  }

  private failUnknown(error: unknown): void {
    const poisoned = this.poison(error);
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(poisoned);
    }
    this.socket?.close(1011, 'unknown stream write outcome');
  }

  private poison(error: unknown): unknown {
    if (this.mode !== 'poisoned') {
      this.mode = 'poisoned';
      this.poisonError = error;
    }
    return this.poisonError;
  }
}

export function createStreamWriteSession(
  runId: string,
  name: string,
  writerId: string,
  config: APIConfig | undefined,
  writeHttp: (chunks: (string | Uint8Array)[]) => Promise<void>,
  closeHttp: () => Promise<void>
): StreamWriteSession {
  return new VercelStreamWriteSession(
    runId,
    name,
    StreamWriterIdSchema.parse(writerId),
    config,
    writeHttp,
    closeHttp
  );
}
