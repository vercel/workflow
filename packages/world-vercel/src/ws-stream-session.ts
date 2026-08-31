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
import {
  getWsStreamWritePipelineDepth,
  isWsStreamsTransportEnabled,
} from './ws-transport-enabled.js';

type Mode = 'connecting' | 'ws' | 'http' | 'closed' | 'poisoned';
type PendingRequest = {
  reqId: number;
  frame: Uint8Array;
  resolve: (meta: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};
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
 * One stateful stream-writer lifetime. Pipelined requests are emitted in order;
 * any unknown outcome poisons every unresolved request rather than replaying it.
 */
class VercelStreamWriteSession implements StreamWriteSession {
  private mode: Mode = 'connecting';
  private socket: WebSocket | undefined;
  private connect: Promise<void>;
  private transportDecision: Promise<void>;
  readonly maxInFlightWrites = getWsStreamWritePipelineDepth();
  private httpTail = Promise.resolve();
  private inbound = Promise.resolve();
  private nextReqId = 1;
  private activeRequests = 0;
  private requestQueue: PendingRequest[] = [];
  private pending = new Map<number, PendingRequest>();
  private completedThroughReqId = 0;
  private completedOutOfOrderReqIds = new Set<number>();
  private writeOperations = new Set<Promise<void>>();
  private closing = false;
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
    if (this.closing)
      return Promise.reject(new Error('stream writer is closing'));
    const operation = this.writeInternal(chunkSeq, chunks);
    this.writeOperations.add(operation);
    void operation.then(
      () => this.writeOperations.delete(operation),
      () => this.writeOperations.delete(operation)
    );
    return operation;
  }

  private async writeInternal(
    chunkSeq: number,
    chunks: (string | Uint8Array)[]
  ): Promise<void> {
    this.assertUsable();
    await this.transportDecision;
    this.assertUsable();
    if (this.mode === 'http') {
      const result = this.httpTail.then(() => this.writeHttp(chunks));
      // Preserve a rejected tail so every already-launched later group inherits
      // the first failure without issuing another HTTP write. Observe it on a
      // separate branch solely to avoid an unhandled rejection.
      this.httpTail = result;
      void result.catch(() => {});
      return result;
    }
    const requests: Array<Promise<Record<string, unknown>>> = [];
    for (
      let offset = 0;
      offset < chunks.length;
      offset += STREAM_WS_V1_MAX_CHUNKS_PER_WRITE
    ) {
      const batch = chunks.slice(
        offset,
        offset + STREAM_WS_V1_MAX_CHUNKS_PER_WRITE
      );
      requests.push(
        this.request((reqId) =>
          encodeStreamWsWriteRequest(
            {
              type: 'write',
              reqId,
              chunkSeq: chunkSeq + offset,
              numChunks: batch.length,
            },
            batch
          )
        )
      );
    }
    const replies = await Promise.all(requests);
    for (const reply of replies) {
      if (reply.type !== 'write_ack') {
        const error = new Error(
          `stream WebSocket write received ${reply.type}`
        );
        this.failUnknown(error);
        throw this.poisonError;
      }
    }
  }

  dispose(): void {
    if (this.mode === 'closed') return;
    const error = new Error('stream writer transport disposed');
    this.mode = 'closed';
    this.rejectAll(error);
    this.socket?.close(1000, 'stream writer disposed');
  }

  async close(): Promise<void> {
    this.assertUsable();
    this.closing = true;
    await Promise.all(this.writeOperations);
    await this.transportDecision;
    this.assertUsable();
    if (this.mode === 'http') {
      await this.httpTail;
      await this.closeHttp();
      this.mode = 'closed';
      return;
    }
    const reply = await this.request((reqId) =>
      encodeStreamWsCloseRequest({ type: 'close', reqId })
    );
    if (reply.type !== 'close_ack') {
      const error = new Error(`stream WebSocket close received ${reply.type}`);
      this.failUnknown(error);
      throw this.poisonError;
    }
    this.mode = 'closed';
    if (this.socket) beginNormalWsClose(this.socket, 'stream closed');
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
      const pending =
        reply.reqId === undefined ? undefined : this.pending.get(reply.reqId);
      if (!pending) {
        if (
          reply.reqId !== undefined &&
          (reply.reqId <= this.completedThroughReqId ||
            this.completedOutOfOrderReqIds.has(reply.reqId)) &&
          ((reply.type === 'write_ack' && !this.closeAcknowledged) ||
            (reply.type === 'close_ack' && this.closeAcknowledged))
        ) {
          return;
        }
        throw new Error('stream WebSocket reply cannot be correlated');
      }
      this.pending.delete(pending.reqId);
      this.activeRequests--;
      if (pending.timer) clearTimeout(pending.timer);
      if (reply.type === 'close_ack') this.closeAcknowledged = true;
      if (reply.type === 'error') {
        const poisoned = this.poison(
          new Error(
            `stream WebSocket request failed (${reply.status}): ${reply.message ?? 'unknown error'}`
          )
        );
        pending.reject(poisoned);
        this.rejectAll(poisoned);
        this.socket?.close(1011, 'stream request failed');
      } else {
        if (reply.type === 'write_ack') this.idleReconnects = 0;
        this.completedOutOfOrderReqIds.add(pending.reqId);
        while (
          this.completedOutOfOrderReqIds.delete(this.completedThroughReqId + 1)
        ) {
          this.completedThroughReqId++;
        }
        pending.resolve(reply);
        this.pumpRequests();
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
    if (this.pending.size > 0 || this.requestQueue.length > 0) {
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

  private request(
    buildFrame: (reqId: number) => Uint8Array
  ): Promise<Record<string, unknown>> {
    this.assertUsable();
    const reqId = this.nextReqId++;
    let frame: Uint8Array;
    try {
      frame = buildFrame(reqId);
    } catch (error) {
      this.failUnknown(error);
      return Promise.reject(this.poisonError);
    }
    // Queue synchronously so concurrent span setup cannot reorder frames.
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.requestQueue.push({ reqId, frame, resolve, reject });
      this.pumpRequests();
    });
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
      async () => response
    );
  }

  private pumpRequests(): void {
    while (
      this.activeRequests < this.maxInFlightWrites &&
      this.requestQueue.length > 0 &&
      this.mode === 'ws'
    ) {
      const request = this.requestQueue.shift();
      if (!request) return;
      const ws = this.socket;
      if (!ws || ws.readyState !== 1) {
        this.failUnknown(new Error('stream WebSocket is not open'));
        return;
      }
      this.activeRequests++;
      this.pending.set(request.reqId, request);
      request.timer = setTimeout(() => {
        this.failUnknown(
          new Error(
            `stream WebSocket request ${request.reqId} timed out with no reply`
          )
        );
      }, getRequestTimeoutMs());
      request.timer.unref?.();
      try {
        ws.send(request.frame, (error) => {
          if (error) this.failUnknown(error);
        });
      } catch (error) {
        this.failUnknown(error);
      }
    }
  }

  private rejectAll(error: unknown): void {
    const requests = [...this.pending.values(), ...this.requestQueue];
    this.pending.clear();
    this.requestQueue = [];
    this.activeRequests = 0;
    for (const request of requests) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private failUnknown(error: unknown): void {
    const poisoned = this.poison(error);
    this.rejectAll(poisoned);
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
