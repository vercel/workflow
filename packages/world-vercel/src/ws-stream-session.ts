import type { Attributes, Span } from '@opentelemetry/api';
import { getVercelOidcToken } from '@vercel/oidc';
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
  STREAM_WS_INITIAL_CONNECT_TIMEOUT_MS,
  STREAM_WS_RECONNECT_BUDGET_MS,
} from './ws-stream-connect.js';
import {
  getWsStreamWritePipelineDepth,
  isWsStreamsTransportEnabled,
} from './ws-transport-enabled.js';

type Mode =
  | 'deferred'
  | 'waiting_to_connect'
  | 'connecting'
  | 'draining'
  | 'ws'
  | 'http'
  | 'closed'
  | 'poisoned';
type WriteTiming = {
  startedAt: number;
  sessionFirstWrite: boolean;
};
type WriteMetadata = {
  chunkSeq: number;
  numChunks: number;
  frameIndex: number;
  frameCount: number;
};
type ConnectionTiming = {
  attempt: number;
  configStartedAt: number;
  configFinishedAt?: number;
  socketStartedAt?: number;
  openedAt?: number;
  firstWriteSent: boolean;
};
type RequestGroupState = {
  sentAny: boolean;
};
type PendingRequest = {
  reqId: number;
  frame: Uint8Array;
  group?: RequestGroupState;
  fallback?: () => Promise<Record<string, unknown>>;
  resolve: (meta: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  sentAt?: number;
  replyReceivedAt?: number;
  span?: Span;
  writeTiming?: WriteTiming;
  writeMetadata?: WriteMetadata;
  connectionTiming?: ConnectionTiming;
};
const MAX_IDLE_RECONNECTS = 3;

function now(): number {
  return performance.now();
}

function firstWriteAttributes(
  write: WriteTiming | undefined,
  connection: ConnectionTiming | undefined,
  sessionCreatedAt: number
): Attributes {
  if (!write) return {};
  return {
    'workflow.stream.ws.session_first_write': write.sessionFirstWrite,
    'workflow.stream.ws.connection_first_write':
      connection?.firstWriteSent === false,
    'workflow.stream.ws.connection_attempt': connection?.attempt ?? 0,
    'workflow.stream.ws.session_to_write_ms':
      write.startedAt - sessionCreatedAt,
  };
}

function recordFirstWriteSetup(
  span: Span | undefined,
  write: WriteTiming,
  connection: ConnectionTiming | undefined
): void {
  if (connection) connection.firstWriteSent = true;
  const openedAt = connection?.openedAt;
  const socketStartedAt = connection?.socketStartedAt;
  const configFinishedAt = connection?.configFinishedAt;
  span?.setAttributes({
    'workflow.stream.ws.write_wait_for_open_ms': openedAt
      ? Math.max(0, openedAt - write.startedAt)
      : 0,
    ...(socketStartedAt && configFinishedAt
      ? {
          'workflow.stream.ws.connect_setup_ms':
            socketStartedAt - configFinishedAt,
        }
      : {}),
    ...(socketStartedAt && openedAt
      ? { 'workflow.stream.ws.connect_ms': openedAt - socketStartedAt }
      : {}),
    ...(configFinishedAt && connection
      ? {
          'workflow.stream.ws.config_token_ms':
            configFinishedAt - connection.configStartedAt,
        }
      : {}),
  });
}

function recordFirstWriteSend(
  span: Span | undefined,
  write: WriteTiming,
  connection: ConnectionTiming | undefined,
  pending: PendingRequest
): void {
  const sentAt = now();
  pending.sentAt = sentAt;
  span?.setAttributes({
    'workflow.stream.ws.write_to_send_ms': sentAt - write.startedAt,
    ...(connection?.openedAt
      ? {
          'workflow.stream.ws.open_to_send_ms': Math.max(
            0,
            sentAt - connection.openedAt
          ),
        }
      : {}),
  });
}

function recordFirstWriteReply(
  span: Span | undefined,
  write: WriteTiming,
  pending: PendingRequest | undefined
): void {
  if (pending?.sentAt === undefined || pending.replyReceivedAt === undefined) {
    return;
  }
  const processedAt = now();
  span?.setAttributes({
    'workflow.stream.ws.send_to_reply_ms':
      pending.replyReceivedAt - pending.sentAt,
    'workflow.stream.ws.reply_processing_ms':
      processedAt - pending.replyReceivedAt,
    'workflow.stream.ws.write_total_ms': processedAt - write.startedAt,
  });
}
const OIDC_FORCE_REFRESH_BUFFER_MS = 24 * 60 * 60 * 1000;

function readAuthorization(headers: Headers): string | null {
  return headers.get('authorization');
}

class StreamWsRequestNotSentError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
    this.name = 'StreamWsRequestNotSentError';
  }
}

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
  private connect = Promise.resolve();
  private transportDecision = Promise.resolve();
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
  private writeOrdinal = 0;
  private poisonError: unknown;
  private wsUrl: string | undefined;
  private closeAcknowledged = false;
  private idleReconnects = 0;
  private drainReason: 'auth_expiry' | 'max_duration' | undefined;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseDrainWait: (() => void) | undefined;
  private lastAuthorization: string | null = null;
  private readonly sessionCreatedAt = now();
  private sessionHasWrite = false;
  private connectionAttempt = 0;
  private connectionTiming: ConnectionTiming | undefined;

  constructor(
    private readonly runId: string,
    private readonly name: string,
    private readonly writerId: StreamWriterId,
    private readonly config: APIConfig | undefined,
    private readonly writeHttp: (
      chunks: (string | Uint8Array)[],
      attributes?: Attributes,
      onRequestDispatched?: () => void
    ) => Promise<void>,
    private readonly closeHttp: () => Promise<void>,
    private readonly connectAfterFirstWrite: boolean
  ) {
    if (connectAfterFirstWrite) {
      this.mode = 'deferred';
    } else {
      this.startInitialConnect();
    }
  }

  write(chunkSeq: number, chunks: (string | Uint8Array)[]): Promise<void> {
    if (this.closing)
      return Promise.reject(new Error('stream writer is closing'));
    const timing: WriteTiming = {
      startedAt: now(),
      sessionFirstWrite: !this.sessionHasWrite,
    };
    this.sessionHasWrite = true;
    const ordinal = ++this.writeOrdinal;
    const operation = this.writeInternal(chunkSeq, chunks, timing, ordinal);
    this.writeOperations.add(operation);
    void operation.then(
      () => this.writeOperations.delete(operation),
      () => this.writeOperations.delete(operation)
    );
    return operation;
  }

  private async writeInternal(
    chunkSeq: number,
    chunks: (string | Uint8Array)[],
    timing: WriteTiming,
    ordinal: number
  ): Promise<void> {
    this.assertUsable();
    if (this.connectAfterFirstWrite && ordinal === 1) {
      return this.writeFirstGroup(chunks, timing);
    }
    if (this.connectAfterFirstWrite && ordinal === 2) {
      return this.writeSecondGroupAndStartConnect(chunks, timing);
    }
    // Every group classified before the initial OPEN belongs to the sealed HTTP
    // prefix. The shared tail preserves order and prevents an OPEN from moving
    // already-admitted work onto WS.
    if (
      this.connectionAttempt <= 1 &&
      (this.mode === 'deferred' ||
        this.mode === 'waiting_to_connect' ||
        this.mode === 'connecting')
    ) {
      return this.writeWhileInitialConnectRuns(chunks, timing);
    }
    await this.transportDecision;
    await this.httpTail;
    this.assertUsable();
    if (this.mode === 'http')
      return this.enqueueHttp(() => this.writeHttp(chunks));

    const frameCount = Math.ceil(
      chunks.length / STREAM_WS_V1_MAX_CHUNKS_PER_WRITE
    );
    const group: RequestGroupState = { sentAny: false };
    const frames: Array<{
      reqId: number;
      frame: Uint8Array;
      timing: WriteTiming | undefined;
      metadata: WriteMetadata;
      fallback: () => Promise<Record<string, unknown>>;
    }> = [];
    try {
      for (
        let offset = 0, frameIndex = 0;
        offset < chunks.length;
        offset += STREAM_WS_V1_MAX_CHUNKS_PER_WRITE, frameIndex++
      ) {
        const batch = chunks.slice(
          offset,
          offset + STREAM_WS_V1_MAX_CHUNKS_PER_WRITE
        );
        const reqId = this.nextReqId++;
        frames.push({
          reqId,
          frame: encodeStreamWsWriteRequest(
            {
              type: 'write',
              reqId,
              chunkSeq: chunkSeq + offset,
              numChunks: batch.length,
            },
            batch
          ),
          timing: offset === 0 ? timing : undefined,
          metadata: {
            chunkSeq: chunkSeq + offset,
            numChunks: batch.length,
            frameIndex,
            frameCount,
          },
          fallback: async () => {
            await this.enqueueHttp(() => this.writeHttp(batch));
            return { type: 'write_ack', reqId };
          },
        });
      }
    } catch {
      this.fallbackToHttpBeforeSend();
      await this.enqueueHttp(() => this.writeHttp(chunks));
      return;
    }
    const requests = frames.map(
      ({ reqId, frame, timing, metadata, fallback }) =>
        this.requestFrame(reqId, frame, timing, metadata, group, fallback)
    );
    let replies: Record<string, unknown>[];
    try {
      replies = await Promise.all(requests);
    } catch (error) {
      if (!(error instanceof StreamWsRequestNotSentError)) throw error;
      this.fallbackToHttpBeforeSend();
      await this.enqueueHttp(() => this.writeHttp(chunks));
      return;
    }
    for (const reply of replies) {
      if (reply.type !== 'write_ack') {
        this.failUnknown(
          new Error(`stream WebSocket write received ${reply.type}`)
        );
        throw this.poisonError;
      }
    }
  }

  private enqueueHttp(operation: () => Promise<void>): Promise<void> {
    const result = this.httpTail.then(operation);
    this.httpTail = result;
    void result.catch(() => {});
    return result;
  }

  private async writeWhileInitialConnectRuns(
    chunks: (string | Uint8Array)[],
    timing: WriteTiming
  ): Promise<void> {
    // Continue complete groups over HTTP while the initial socket opens in the
    // background. No write waits for the upgrade; the serial operation chain
    // prevents WS from overtaking HTTP. An HTTP failure poisons the writer
    // because its outcome may be unknown and must never be replayed over WS.
    try {
      await this.enqueueHttp(() =>
        this.writeHttp(chunks, {
          'workflow.stream.ws.session_first_write': timing.sessionFirstWrite,
          'workflow.stream.ws.connection_attempt': this.connectionAttempt,
          'workflow.stream.ws.connecting_at_write': true,
          'workflow.stream.ws.session_to_write_ms':
            timing.startedAt - this.sessionCreatedAt,
        })
      );
    } catch (error) {
      this.failUnknown(error);
      throw this.poisonError;
    }
  }

  private async writeSecondGroupAndStartConnect(
    chunks: (string | Uint8Array)[],
    timing: WriteTiming
  ): Promise<void> {
    try {
      await this.enqueueHttp(() =>
        this.writeHttp(
          chunks,
          {
            'workflow.stream.ws.session_first_write': timing.sessionFirstWrite,
            'workflow.stream.ws.connection_attempt': 0,
            'workflow.stream.ws.connecting_at_write': false,
            'workflow.stream.ws.connect_after_http_group': 2,
            'workflow.stream.ws.session_to_write_ms':
              timing.startedAt - this.sessionCreatedAt,
          },
          () => {
            if (this.mode !== 'waiting_to_connect') return;
            this.startInitialConnect();
          }
        )
      );
    } catch (error) {
      this.failUnknown(error);
      throw this.poisonError;
    }
  }

  private async writeFirstGroup(
    chunks: (string | Uint8Array)[],
    timing: WriteTiming
  ): Promise<void> {
    // Keep socket setup off the first-chunk critical path. Only a confirmed
    // HTTP success may start the background upgrade; an ambiguous outcome must
    // never be followed by work on another transport.
    try {
      await this.enqueueHttp(() =>
        this.writeHttp(chunks, {
          'workflow.stream.ws.session_first_write': timing.sessionFirstWrite,
          'workflow.stream.ws.connection_attempt': 0,
          'workflow.stream.ws.connecting_at_write': false,
          'workflow.stream.ws.connect_deferred_at_write': true,
          'workflow.stream.ws.http_group_ordinal': 1,
          'workflow.stream.ws.session_to_write_ms':
            timing.startedAt - this.sessionCreatedAt,
        })
      );
    } catch (error) {
      this.failUnknown(error);
      throw this.poisonError;
    }
    if (this.mode === 'deferred') this.mode = 'waiting_to_connect';
  }

  dispose(): void {
    if (this.mode === 'closed') return;
    this.mode = 'closed';
    this.finishDrainWait();
    this.rejectAll(new Error('stream writer transport disposed'));
    this.socket?.close(1000, 'stream writer disposed');
  }

  async close(): Promise<void> {
    this.assertUsable();
    this.closing = true;
    await Promise.all(this.writeOperations);
    await this.httpTail;
    if (
      this.mode === 'deferred' ||
      this.mode === 'waiting_to_connect' ||
      (this.connectAfterFirstWrite &&
        this.mode === 'connecting' &&
        this.connectionAttempt === 1)
    ) {
      await this.closeHttp();
      this.mode = 'closed';
      this.socket?.close(1000, 'stream closed over HTTP');
      return;
    }
    await this.transportDecision;
    this.assertUsable();
    if (this.mode === 'http') {
      await this.closeHttp();
      this.mode = 'closed';
      return;
    }
    const reply = await this.request((reqId) =>
      encodeStreamWsCloseRequest({ type: 'close', reqId })
    );
    if (reply.type !== 'close_ack') {
      this.failUnknown(
        new Error(`stream WebSocket close received ${reply.type}`)
      );
      throw this.poisonError;
    }
    this.mode = 'closed';
    if (this.socket) beginNormalWsClose(this.socket, 'stream closed');
  }

  private assertUsable(): void {
    if (this.mode === 'poisoned') throw this.poisonError;
    if (this.mode === 'closed') throw new Error('stream writer is closed');
  }

  private startInitialConnect(): void {
    this.mode = 'connecting';
    this.connect = this.startConnect();
    this.transportDecision = this.makeTransportDecision(false);
  }

  /** One shared bounded decision for all operations queued while connecting. */
  private makeTransportDecision(reconnecting: boolean): Promise<void> {
    return new Promise((resolve) => {
      let decided = false;
      const decide = () => {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(
        () => {
          if (this.mode === 'connecting') {
            this.mode = 'http';
            this.socket?.close(1000, 'connect budget expired');
            this.flushQueuedOverHttp();
          }
          decide();
        },
        reconnecting
          ? STREAM_WS_RECONNECT_BUDGET_MS
          : STREAM_WS_INITIAL_CONNECT_TIMEOUT_MS
      );
      timer.unref?.();
      void this.connect.then(decide);
    });
  }

  private startConnect(forceRefresh = false): Promise<void> {
    const startedAt = now();
    const timing: ConnectionTiming = {
      attempt: ++this.connectionAttempt,
      configStartedAt: startedAt,
      firstWriteSent: false,
    };
    this.connectionTiming = timing;
    return this.connectSocket(forceRefresh, timing).catch(() => {
      // Every failure before OPEN is a safe, session-long HTTP fallback. The
      // HTTP request itself still surfaces auth/configuration errors normally.
      if (this.mode === 'connecting') {
        this.mode = 'http';
        this.flushQueuedOverHttp();
      }
    });
  }

  private async connectSocket(
    forceRefresh: boolean,
    timing: ConnectionTiming
  ): Promise<void> {
    if (!isWsStreamsTransportEnabled()) {
      this.mode = 'http';
      this.flushQueuedOverHttp();
      return;
    }
    if (forceRefresh) {
      // Included in config_token_ms: a slow refresh must not disappear from the
      // first write after an auth-expiry reconnect.
      // Outside a Vercel function this invalidates @vercel/oidc's cached token.
      // Inside one, the invocation header remains authoritative; reconnecting
      // still re-resolves headers rather than retaining the old upgrade object.
      await getVercelOidcToken({
        expirationBufferMs: OIDC_FORCE_REFRESH_BUFFER_MS,
      }).catch(() => undefined);
    }
    const httpPromise = getHttpConfig(this.config).then((http) => {
      timing.configFinishedAt = now();
      return http;
    });
    const [{ WebSocket: WebSocketImpl }, http] = await Promise.all([
      import('ws'),
      httpPromise,
    ]);
    if (this.mode !== 'connecting') return;
    if (
      forceRefresh &&
      readAuthorization(http.headers) === this.lastAuthorization
    ) {
      // A Vercel invocation's context token cannot be refreshed in place. Do
      // not reconnect with the bearer the server is explicitly draining.
      this.mode = 'http';
      this.flushQueuedOverHttp();
      return;
    }
    this.lastAuthorization = readAuthorization(http.headers);
    if (http.usingProxy) {
      this.mode = 'http';
      this.flushQueuedOverHttp();
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
        timing.socketStartedAt = now();
        const ws = new WebSocketImpl(url, {
          headers: headersToRecord(http.headers),
        });
        this.socket = ws;
        ws.binaryType = 'nodebuffer';

        await new Promise<void>((resolve) => {
          let opened = false;
          const fallback = () => {
            if (opened) return;
            if (this.mode === 'connecting') {
              this.mode = 'http';
              this.flushQueuedOverHttp();
            }
            resolve();
          };
          ws.once('open', () => {
            opened = true;
            timing.openedAt = now();
            if (this.mode !== 'connecting') {
              ws.close(1000, 'HTTP fallback selected');
              resolve();
              return;
            }
            this.mode = 'ws';
            this.pumpRequests();
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
          ws.once('close', (code) => {
            if (!opened) {
              fallback();
              return;
            }
            // A server may queue close immediately after its terminal reply.
            // Let the already-delivered message finish decoding first. Pass the
            // socket so a late close from a forced drain cannot retire its
            // replacement.
            void this.inbound.then(() =>
              this.handleSocketClose(Number(code), ws)
            );
          });
          ws.on('message', (raw) => {
            const receivedAt = now();
            this.inbound = this.inbound.then(() =>
              this.handleMessage(asBytes(raw), receivedAt)
            );
          });
        });
      }
    );
  }

  private async handleMessage(
    raw: Uint8Array,
    receivedAt: number
  ): Promise<void> {
    try {
      const frame = await decodeOne(raw);
      const reply = parseStreamWsReply(frame.meta, frame.body);
      if (reply.type === 'drain') {
        this.handleDrain(reply.reason, reply.graceMs);
        return;
      }
      const pending =
        reply.reqId === undefined ? undefined : this.pending.get(reply.reqId);
      if (!pending) {
        if (reply.type === 'error') {
          throw new Error(
            `stream WebSocket connection failed (${reply.status}): ${reply.message ?? 'unknown error'}`
          );
        }
        if (
          reply.reqId !== undefined &&
          (reply.reqId <= this.completedThroughReqId ||
            this.completedOutOfOrderReqIds.has(reply.reqId))
        ) {
          return;
        }
        throw new Error('stream WebSocket reply cannot be correlated');
      }
      this.pending.delete(pending.reqId);
      this.activeRequests--;
      pending.replyReceivedAt = receivedAt;
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

  private handleDrain(
    reason: 'auth_expiry' | 'max_duration',
    graceMs: number
  ): void {
    if (this.mode === 'draining') {
      if (reason === 'auth_expiry') this.drainReason = reason;
      return;
    }
    if (this.mode !== 'ws') return;
    this.mode = 'draining';
    this.drainReason = reason;
    this.transportDecision = new Promise<void>((resolve) => {
      this.releaseDrainWait = resolve;
    });
    const socket = this.socket;
    this.drainTimer = setTimeout(
      () => {
        this.drainTimer = undefined;
        if (this.mode !== 'draining' || socket !== this.socket) return;
        if (this.pending.size > 0) {
          this.failUnknown(
            new Error('stream WebSocket drain expired before request reply')
          );
          return;
        }
        socket?.close(1001, 'stream drain grace expired');
        this.handleSocketClose(1001, socket);
      },
      Math.min(graceMs, 2_147_483_647)
    );
    this.drainTimer.unref?.();
  }

  private handleSocketClose(code: number, socket = this.socket): void {
    if (socket !== this.socket) return;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    if (
      this.mode === 'closed' ||
      this.mode === 'http' ||
      this.mode === 'poisoned' ||
      this.closeAcknowledged
    ) {
      return;
    }
    if (this.pending.size > 0) {
      this.failUnknown(new Error('stream WebSocket closed before reply'));
      return;
    }
    if (this.mode === 'draining' && code !== 1001) {
      // No request is pending, so there is no unknown write to protect. The
      // promised drain close shape was not honored; fail closed to HTTP rather
      // than leaving queued operations parked forever.
      this.drainReason = undefined;
      this.mode = 'http';
      this.socket = undefined;
      this.flushQueuedOverHttp();
      this.finishDrainWait();
      return;
    }
    if (this.mode === 'draining') {
      const forceRefresh = this.drainReason === 'auth_expiry';
      this.drainReason = undefined;
      if (this.idleReconnects >= MAX_IDLE_RECONNECTS) {
        this.mode = 'http';
        this.socket = undefined;
        this.flushQueuedOverHttp();
        this.finishDrainWait();
        return;
      }
      this.idleReconnects++;
      this.mode = 'connecting';
      this.socket = undefined;
      this.connect = this.startConnect(forceRefresh);
      const nextDecision = this.makeTransportDecision(true);
      this.transportDecision = nextDecision;
      void nextDecision.then(() => this.finishDrainWait());
      return;
    }
    // Clean idle infrastructure close: reconnect with the same writer identity
    // and next writer-local sequence, but cap eager attempts so a draining
    // server cannot create an open/close hot loop for the invocation lifetime.
    // Do not proactively recycle an accepted v1 connection: without a drain
    // control frame, the client cannot fence a concurrent server-side teardown
    // from a newly opened socket. A future protocol may add that handshake.
    if (this.idleReconnects >= MAX_IDLE_RECONNECTS) {
      this.mode = 'http';
      this.socket = undefined;
      this.flushQueuedOverHttp();
      return;
    }
    this.idleReconnects++;
    this.mode = 'connecting';
    this.socket = undefined;
    this.connect = this.startConnect();
    this.transportDecision = this.makeTransportDecision(true);
  }

  private request(
    buildFrame: (reqId: number) => Uint8Array,
    writeTiming?: WriteTiming,
    writeMetadata?: WriteMetadata
  ): Promise<Record<string, unknown>> {
    this.assertUsable();
    const reqId = this.nextReqId++;
    let frame: Uint8Array;
    try {
      frame = buildFrame(reqId);
    } catch (error) {
      return Promise.reject(new StreamWsRequestNotSentError(error));
    }
    return this.requestFrame(reqId, frame, writeTiming, writeMetadata);
  }

  private requestFrame(
    reqId: number,
    frame: Uint8Array,
    writeTiming?: WriteTiming,
    writeMetadata?: WriteMetadata,
    group?: RequestGroupState,
    fallback?: () => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    this.assertUsable();
    const connectionTiming = this.connectionTiming;
    const connectionFirstWrite = connectionTiming?.firstWriteSent === false;
    const detailedTiming =
      writeTiming && (writeTiming.sessionFirstWrite || connectionFirstWrite)
        ? writeTiming
        : undefined;
    return withHttpClientSpan(
      {
        method: 'POST',
        url: this.wsUrl ?? 'ws://unknown',
        spanName: 'workflow.stream.write',
        attributes: {
          'workflow.stream.transport': 'ws',
          'workflow.stream.ws.req_id': reqId,
          'workflow.stream.ws.pipeline_depth': this.maxInFlightWrites,
          ...(writeMetadata
            ? {
                'workflow.stream.ws.chunk_seq': writeMetadata.chunkSeq,
                'workflow.stream.ws.num_chunks': writeMetadata.numChunks,
                'workflow.stream.ws.frame_chunks': writeMetadata.numChunks,
                'workflow.stream.ws.frame_bytes': frame.byteLength,
                'workflow.stream.ws.frame_index': writeMetadata.frameIndex,
                'workflow.stream.ws.frame_count': writeMetadata.frameCount,
              }
            : {}),
          ...firstWriteAttributes(
            detailedTiming,
            connectionTiming,
            this.sessionCreatedAt
          ),
        },
      },
      async (span) => {
        let queued: PendingRequest | undefined;
        const response = new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            queued = {
              reqId,
              frame,
              group,
              fallback,
              resolve,
              reject,
              span,
              writeTiming,
              writeMetadata,
              connectionTiming,
            };
            this.requestQueue.push(queued);
            this.pumpRequests();
          }
        );
        try {
          return await response;
        } finally {
          if (detailedTiming)
            recordFirstWriteReply(span, detailedTiming, queued);
        }
      }
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
        const cause = new Error('stream WebSocket is not open before send');
        if (request.group?.sentAny || this.pending.size > 0) {
          this.failUnknown(cause);
        } else {
          const error = new StreamWsRequestNotSentError(cause);
          request.reject(error);
          this.rejectAll(error);
        }
        return;
      }
      const connectionTiming = this.connectionTiming;
      const detailedTiming =
        request.writeTiming &&
        (request.writeTiming.sessionFirstWrite ||
          connectionTiming?.firstWriteSent === false)
          ? request.writeTiming
          : undefined;
      request.span?.setAttributes({
        'workflow.stream.ws.inflight_at_send': this.activeRequests + 1,
        ...firstWriteAttributes(
          detailedTiming,
          connectionTiming,
          this.sessionCreatedAt
        ),
      });
      if (detailedTiming) {
        recordFirstWriteSetup(request.span, detailedTiming, connectionTiming);
      }
      request.connectionTiming = connectionTiming;
      request.writeTiming = detailedTiming;
      if (request.group) request.group.sentAny = true;
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
      if (request.writeTiming) {
        recordFirstWriteSend(
          request.span,
          request.writeTiming,
          request.connectionTiming,
          request
        );
      }
      try {
        ws.send(request.frame, (error) => {
          if (error) this.failUnknown(error);
        });
      } catch (error) {
        this.failUnknown(error);
      }
    }
  }

  private flushQueuedOverHttp(): void {
    const queued = this.requestQueue;
    this.requestQueue = [];
    void (async () => {
      for (const request of queued) {
        if (!request.fallback) {
          this.failUnknown(
            new Error('queued stream WebSocket request cannot fall back')
          );
          return;
        }
        try {
          request.resolve(await request.fallback());
        } catch (error) {
          this.failUnknown(error);
          return;
        }
      }
    })();
  }

  private finishDrainWait(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    const release = this.releaseDrainWait;
    this.releaseDrainWait = undefined;
    release?.();
  }

  private fallbackToHttpBeforeSend(): void {
    this.mode = 'http';
    this.socket?.close(1000, 'HTTP fallback before send');
    this.socket = undefined;
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
    this.finishDrainWait();
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
  writeHttp: (
    chunks: (string | Uint8Array)[],
    attributes?: Attributes,
    onRequestDispatched?: () => void
  ) => Promise<void>,
  closeHttp: () => Promise<void>,
  connectAfterFirstWrite = true
): StreamWriteSession {
  return new VercelStreamWriteSession(
    runId,
    name,
    StreamWriterIdSchema.parse(writerId),
    config,
    writeHttp,
    closeHttp,
    connectAfterFirstWrite
  );
}
