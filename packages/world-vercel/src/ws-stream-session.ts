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
import { isWsStreamsTransportEnabled } from './ws-transport-enabled.js';

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
};
type ConnectionTiming = {
  attempt: number;
  configStartedAt: number;
  configFinishedAt?: number;
  socketStartedAt?: number;
  openedAt?: number;
  firstWriteSent: boolean;
};
type PendingRequest = {
  reqId: number;
  resolve: (meta: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  sentAt?: number;
  replyReceivedAt?: number;
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
  private tail = Promise.resolve();
  private inbound = Promise.resolve();
  private nextReqId = 1;
  private pending: PendingRequest | undefined;
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
    const timing: WriteTiming = {
      startedAt: now(),
      sessionFirstWrite: !this.sessionHasWrite,
    };
    this.sessionHasWrite = true;
    return this.enqueue(() => this.writeInternal(chunkSeq, chunks, timing));
  }

  private async writeInternal(
    chunkSeq: number,
    chunks: (string | Uint8Array)[],
    timing: WriteTiming
  ): Promise<void> {
    this.assertUsable();
    if (this.mode === 'deferred') {
      await this.writeFirstGroup(chunks, timing);
      return;
    }
    if (this.mode === 'waiting_to_connect') {
      await this.writeSecondGroupAndStartConnect(chunks, timing);
      return;
    }
    if (this.shouldWriteHttpWhileConnecting()) {
      await this.writeWhileInitialConnectRuns(chunks, timing);
      return;
    }
    await this.transportDecision;
    this.assertUsable();
    if (this.mode === 'http') {
      await this.writeHttp(chunks);
      return;
    }
    // Core's default group cap equals the wire cap, so splitting is normally
    // dormant. Keep it here as a guard against configured or future cap drift;
    // v1 deliberately defines no separate whole-message byte budget.
    for (
      let offset = 0;
      offset < chunks.length;
      offset += STREAM_WS_V1_MAX_CHUNKS_PER_WRITE
    ) {
      const batch = chunks.slice(
        offset,
        offset + STREAM_WS_V1_MAX_CHUNKS_PER_WRITE
      );
      let reply: Record<string, unknown>;
      try {
        reply = await this.request(
          (reqId) =>
            encodeStreamWsWriteRequest(
              {
                type: 'write',
                reqId,
                chunkSeq: chunkSeq + offset,
                numChunks: batch.length,
              },
              batch
            ),
          offset === 0 ? timing : undefined,
          { chunkSeq: chunkSeq + offset, numChunks: batch.length }
        );
      } catch (error) {
        if (!(error instanceof StreamWsRequestNotSentError)) throw error;
        this.fallbackToHttpBeforeSend();
        await this.writeHttp(chunks.slice(offset));
        return;
      }
      if (reply.type !== 'write_ack') {
        throw this.poison(
          new Error(`stream WebSocket write received ${reply.type}`)
        );
      }
    }
  }

  private shouldWriteHttpWhileConnecting(): boolean {
    return this.mode === 'connecting' && this.connectionAttempt === 1;
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
      await this.writeHttp(chunks, {
        'workflow.stream.ws.session_first_write': timing.sessionFirstWrite,
        'workflow.stream.ws.connection_attempt': this.connectionAttempt,
        'workflow.stream.ws.connecting_at_write': true,
        'workflow.stream.ws.session_to_write_ms':
          timing.startedAt - this.sessionCreatedAt,
      });
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
      await this.writeHttp(
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
      await this.writeHttp(chunks, {
        'workflow.stream.ws.session_first_write': timing.sessionFirstWrite,
        'workflow.stream.ws.connection_attempt': 0,
        'workflow.stream.ws.connecting_at_write': false,
        'workflow.stream.ws.connect_deferred_at_write': true,
        'workflow.stream.ws.http_group_ordinal': 1,
        'workflow.stream.ws.session_to_write_ms':
          timing.startedAt - this.sessionCreatedAt,
      });
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
      let reply: Record<string, unknown>;
      try {
        reply = await this.request((reqId) =>
          encodeStreamWsCloseRequest({ type: 'close', reqId })
        );
      } catch (error) {
        if (!(error instanceof StreamWsRequestNotSentError)) throw error;
        this.fallbackToHttpBeforeSend();
        await this.closeHttp();
        this.mode = 'closed';
        return;
      }
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
      if (this.mode === 'connecting') this.mode = 'http';
    });
  }

  private async connectSocket(
    forceRefresh: boolean,
    timing: ConnectionTiming
  ): Promise<void> {
    if (!isWsStreamsTransportEnabled()) {
      this.mode = 'http';
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
      return;
    }
    this.lastAuthorization = readAuthorization(http.headers);
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
            if (this.mode === 'connecting') this.mode = 'http';
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
      const pending = this.pending;
      if (
        !pending ||
        reply.reqId === undefined ||
        reply.reqId !== pending.reqId
      ) {
        if (reply.type === 'error') {
          throw new Error(
            `stream WebSocket connection failed (${reply.status}): ${reply.message ?? 'unknown error'}`
          );
        }
        throw new Error('stream WebSocket reply cannot be correlated');
      }
      this.pending = undefined;
      pending.replyReceivedAt = receivedAt;
      clearTimeout(pending.timer);
      if (reply.type === 'close_ack') this.closeAcknowledged = true;
      if (reply.type === 'error') {
        // v1 is fail-stop and provides no machine-readable retry class. HTTP
        // status alone cannot prove whether a rejected write was appended, so
        // every correlated error remains terminal until the protocol can state
        // that retrying (or continuing this connection) is safe.
        pending.reject(
          this.poison(
            new Error(
              `stream WebSocket request failed (${reply.status}): ${reply.message ?? 'unknown error'}`
            )
          )
        );
        this.socket?.close(1011, 'stream request failed');
      } else {
        if (reply.type === 'write_ack') this.idleReconnects = 0;
        pending.resolve(reply);
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
        if (this.pending) {
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
    if (this.pending) {
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
      this.finishDrainWait();
      return;
    }
    if (this.mode === 'draining') {
      const forceRefresh = this.drainReason === 'auth_expiry';
      this.drainReason = undefined;
      if (this.idleReconnects >= MAX_IDLE_RECONNECTS) {
        this.mode = 'http';
        this.socket = undefined;
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
      return;
    }
    this.idleReconnects++;
    this.mode = 'connecting';
    this.socket = undefined;
    this.connect = this.startConnect();
    this.transportDecision = this.makeTransportDecision(true);
  }

  private async request(
    buildFrame: (reqId: number) => Uint8Array,
    writeTiming?: WriteTiming,
    writeMetadata?: WriteMetadata
  ): Promise<Record<string, unknown>> {
    this.assertUsable();
    const ws = this.socket;
    if (this.mode !== 'ws' || !ws || ws.readyState !== 1) {
      throw new StreamWsRequestNotSentError(
        new Error('stream WebSocket is not open before send')
      );
    }
    const reqId = this.nextReqId++;
    let frame: Uint8Array;
    try {
      frame = buildFrame(reqId);
    } catch (error) {
      throw new StreamWsRequestNotSentError(error);
    }
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
          ...(writeMetadata
            ? {
                'workflow.stream.ws.chunk_seq': writeMetadata.chunkSeq,
                'workflow.stream.ws.num_chunks': writeMetadata.numChunks,
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
        if (detailedTiming) {
          recordFirstWriteSetup(span, detailedTiming, connectionTiming);
        }
        let pending: PendingRequest | undefined;
        const response = new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            // With no v1 progress/control reply, silence cannot distinguish a
            // slow accepted request from a dead socket. Expiry is therefore an
            // unknown outcome and must poison rather than replay.
            const timer = setTimeout(() => {
              this.failUnknown(
                new Error(
                  `stream WebSocket request ${reqId} timed out with no reply`
                )
              );
            }, getRequestTimeoutMs());
            timer.unref?.();
            pending = { reqId, resolve, reject, timer };
            this.pending = pending;
            try {
              if (detailedTiming) {
                recordFirstWriteSend(
                  span,
                  detailedTiming,
                  connectionTiming,
                  pending
                );
              }
              ws.send(frame, (error) => {
                if (!error) return;
                this.failUnknown(error);
              });
            } catch (error) {
              this.failUnknown(error);
            }
          }
        );
        try {
          return await response;
        } finally {
          if (detailedTiming) {
            recordFirstWriteReply(span, detailedTiming, pending);
          }
        }
      }
    );
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

  private failUnknown(error: unknown): void {
    const poisoned = this.poison(error);
    this.finishDrainWait();
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
