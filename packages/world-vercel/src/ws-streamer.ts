import { globalSingleton } from '@workflow/utils';
import { WebSocket } from 'ws';
import { decodeFrames, encodeFrame } from './frames.js';
import { getRequestTimeoutMs, headersToRecord } from './http-core.js';
import { encodeMultiChunks, getMaxChunksPerRequest } from './streamer.js';
import { injectTraceContextIntoHeaders } from './telemetry.js';
import type { APIConfig } from './utils.js';
import { getHttpConfig, getHttpUrl } from './utils.js';
import { version } from './version.js';

const EMPTY = new Uint8Array(0);
const MAX_IN_FLIGHT_BATCHES = 1;
const IDLE_TIMEOUT_MS = 30_000;

type Reply = { meta: Record<string, unknown>; body: Uint8Array };
type Pending = {
  resolve: (reply: Reply) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
}

function streamWsUrl(baseUrl: string, runId: string, name: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/websockets/v1/runs/${encodeURIComponent(runId)}/streams/${encodeURIComponent(name)}`;
  return url.toString();
}

class StreamWriterSocket {
  private ws: WebSocket | undefined;
  private nextReqId = 1;
  private pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    readonly url: string,
    private readonly onClose: () => void
  ) {}

  async connect(config?: APIConfig): Promise<void> {
    const { headers } = await getHttpConfig(config);
    await injectTraceContextIntoHeaders(headers);
    const ws = new WebSocket(this.url, { headers: headersToRecord(headers) });
    this.ws = ws;
    ws.binaryType = 'nodebuffer';

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      ws.once('open', () => {
        opened = true;
        this.armIdleTimer();
        resolve();
      });
      ws.once('error', (error) => {
        if (!opened) reject(error);
        else this.fail(error);
      });
      ws.once('close', () => {
        if (!opened)
          reject(
            new Error(
              `stream WebSocket upgrade closed before opening (${this.url})`
            )
          );
        this.fail(new Error(`stream WebSocket closed (${this.url})`));
      });
      ws.on('message', (raw: Buffer) => {
        void this.handleMessage(new Uint8Array(raw));
      });
    });
  }

  async request(buildFrame: (reqId: number) => Uint8Array): Promise<Reply> {
    const ws = this.ws;
    if (this.closed || !ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`stream WebSocket is not open (${this.url})`);
    }
    this.cancelIdleTimer();
    const reqId = this.nextReqId++;
    const timeoutMs = getRequestTimeoutMs();
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(reqId)) return;
        const error = new Error(
          `stream WebSocket request ${reqId} timed out after ${timeoutMs}ms`
        );
        reject(error);
        this.fail(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(reqId, { resolve, reject, timer });
      ws.send(buildFrame(reqId), (error) => {
        if (!error) return;
        const pending = this.pending.get(reqId);
        if (!pending) return;
        this.pending.delete(reqId);
        clearTimeout(pending.timer);
        reject(error);
        this.fail(error);
      });
    }).finally(() => this.armIdleTimer());
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelIdleTimer();
    this.onClose();
    this.ws?.close(1000, reason);
    this.rejectPending(new Error(`stream WebSocket closed: ${reason}`));
  }

  private async handleMessage(raw: Uint8Array): Promise<void> {
    const frames = [];
    try {
      for await (const frame of decodeFrames(
        (async function* () {
          yield raw;
        })()
      )) {
        frames.push(frame);
      }
    } catch (error) {
      this.fail(error);
      return;
    }
    if (frames.length !== 1) {
      this.fail(
        new Error(`stream WebSocket message contained ${frames.length} frames`)
      );
      return;
    }
    const frame = frames[0];
    const reqId = frame.meta.reqId;
    if (typeof reqId !== 'number') {
      this.fail(new Error('stream WebSocket reply carried no numeric reqId'));
      return;
    }
    const pending = this.pending.get(reqId);
    if (!pending) return;
    this.pending.delete(reqId);
    clearTimeout(pending.timer);
    pending.resolve({ meta: frame.meta, body: frame.body });
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelIdleTimer();
    this.onClose();
    this.rejectPending(error);
    this.ws?.close();
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private armIdleTimer(): void {
    if (this.closed || this.pending.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(
      () => this.close('idle timeout'),
      IDLE_TIMEOUT_MS
    );
    this.idleTimer.unref?.();
  }

  private cancelIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

type WriterState = {
  socket?: StreamWriterSocket;
  connect: Promise<void>;
  status: 'connecting' | 'open' | 'http' | 'closed';
  httpBarrier: Promise<void>;
  httpPending: number;
  httpFailure?: unknown;
  inFlight: number;
  slotWaiters: Array<() => void>;
  drainWaiters: Array<() => void>;
};

const state = globalSingleton(
  `@workflow/world-vercel//wsStreamWriters@${version}`,
  1,
  () => new Map<string, WriterState>()
);

function writerKey(
  runId: string,
  name: string,
  config?: APIConfig
): string | null {
  const { baseUrl, usingProxy } = getHttpUrl(config);
  if (usingProxy) return null;
  return streamWsUrl(baseUrl, runId, name);
}

function getWriter(
  runId: string,
  name: string,
  config?: APIConfig
): WriterState | null {
  const key = writerKey(runId, name, config);
  if (!key) return null;
  const existing = state.get(key);
  if (existing && existing.status !== 'closed') return existing;

  const writer: WriterState = {
    status: 'connecting',
    httpBarrier: Promise.resolve(),
    httpPending: 0,
    inFlight: 0,
    slotWaiters: [],
    drainWaiters: [],
    connect: Promise.resolve(),
  };
  const socket = new StreamWriterSocket(key, () => {
    if (state.get(key) === writer && writer.status !== 'http') {
      state.delete(key);
    }
    if (writer.status !== 'closed') writer.status = 'http';
  });
  writer.socket = socket;
  writer.connect = socket
    .connect(config)
    .then(() => {
      if (writer.status === 'connecting') writer.status = 'open';
      else socket.close('upgrade no longer needed');
    })
    .catch((error) => {
      console.warn(
        `world-vercel: stream WebSocket upgrade failed; using HTTP (${describeError(error)}).`
      );
      writer.status = 'http';
      // Keep a per-stream HTTP tombstone after a declined upgrade. Removing it
      // here makes the next append construct another socket, turning an
      // unsupported endpoint into one upgrade attempt per batch. `close()`
      // removes the tombstone so a later lifecycle can negotiate afresh.
      state.set(key, writer);
    });
  state.set(key, writer);
  return writer;
}

function sendHttp(
  state: WriterState,
  fallback: () => Promise<void>
): Promise<void> {
  state.httpPending++;
  const operation = state.httpBarrier.then(fallback);
  state.httpBarrier = operation
    .catch((error) => {
      state.httpFailure = error;
      state.status = 'http';
      state.socket?.close('HTTP barrier failed');
    })
    .finally(() => {
      state.httpPending--;
    });
  return operation;
}

function successfulReply(operation: 'write' | 'close', reply: Reply): void {
  const { status, type } = reply.meta;
  if (
    type !== 'stream_ack' ||
    typeof status !== 'number' ||
    status < 200 ||
    status >= 300
  ) {
    const detail = new TextDecoder().decode(reply.body);
    throw new Error(
      `Stream ${operation} failed over WS: status ${String(status ?? 'unknown')}` +
        (detail ? `: ${detail}` : '')
    );
  }
}

async function acquireBatchSlot(writer: WriterState): Promise<() => void> {
  if (writer.inFlight >= MAX_IN_FLIGHT_BATCHES) {
    await new Promise<void>((resolve) => writer.slotWaiters.push(resolve));
  } else {
    writer.inFlight++;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = writer.slotWaiters.shift();
    if (next) {
      next();
      return;
    }
    writer.inFlight--;
    if (writer.inFlight === 0) {
      for (const resolve of writer.drainWaiters.splice(0)) resolve();
    }
  };
}

async function waitForBatches(writer: WriterState): Promise<void> {
  if (writer.inFlight === 0) return;
  await new Promise<void>((resolve) => writer.drainWaiters.push(resolve));
}

async function sendBatch(
  writer: WriterState,
  count: number,
  body: Uint8Array
): Promise<void> {
  await writer.httpBarrier;
  const release = await acquireBatchSlot(writer);
  try {
    if (writer.status !== 'open' || !writer.socket) {
      throw new Error('stream WebSocket became unavailable after upgrade');
    }
    const reply = await writer.socket.request((reqId) =>
      encodeFrame({ reqId, type: 'stream_write', count }, body)
    );
    successfulReply('write', reply);
  } finally {
    release();
  }
}

export async function writeStreamOverWs(
  runId: string,
  name: string,
  chunk: string | Uint8Array,
  config: APIConfig | undefined,
  httpFallback: () => Promise<void>
): Promise<void> {
  const writer = getWriter(runId, name, config);
  if (!writer || writer.status !== 'open' || writer.httpPending > 0) {
    if (writer) void writer.connect;
    return writer ? sendHttp(writer, httpFallback) : httpFallback();
  }
  return sendBatch(writer, 1, asBytes(chunk));
}

export async function writeMultiStreamOverWs(
  runId: string,
  name: string,
  chunks: (string | Uint8Array)[],
  config: APIConfig | undefined,
  httpFallback: () => Promise<void>
): Promise<void> {
  const writer = getWriter(runId, name, config);
  if (!writer || writer.status !== 'open' || writer.httpPending > 0) {
    if (writer) void writer.connect;
    return writer ? sendHttp(writer, httpFallback) : httpFallback();
  }

  const batches: Array<{ count: number; body: Uint8Array }> = [];
  const limit = getMaxChunksPerRequest();
  for (let i = 0; i < chunks.length; i += limit) {
    const batch = chunks.slice(i, i + limit);
    batches.push({
      count: batch.length,
      body: batch.length === 1 ? asBytes(batch[0]) : encodeMultiChunks(batch),
    });
  }

  for (let i = 0; i < batches.length; i += MAX_IN_FLIGHT_BATCHES) {
    await Promise.all(
      batches
        .slice(i, i + MAX_IN_FLIGHT_BATCHES)
        .map((batch) => sendBatch(writer, batch.count, batch.body))
    );
  }
}

export async function closeStreamOverWs(
  runId: string,
  name: string,
  config: APIConfig | undefined,
  httpFallback: () => Promise<void>
): Promise<void> {
  const key = writerKey(runId, name, config);
  const writer = key ? state.get(key) : undefined;
  if (!writer || writer.status !== 'open' || writer.httpPending > 0) {
    if (writer && key) {
      writer.status = 'closed';
      writer.socket?.close('close stayed on HTTP');
      state.delete(key);
      await writer.httpBarrier;
      if (writer.httpFailure !== undefined) throw writer.httpFailure;
    }
    return httpFallback();
  }

  const socket = writer.socket;
  if (!socket || !key) return httpFallback();
  await writer.httpBarrier;
  await waitForBatches(writer);
  const reply = await socket.request((reqId: number) =>
    encodeFrame({ reqId, type: 'stream_close' }, EMPTY)
  );
  successfulReply('close', reply);
  writer.status = 'closed';
  socket.close('stream closed');
  state.delete(key);
}

export function resetWsStreamWritersForTest(): void {
  for (const writer of state.values()) writer.socket?.close('test reset');
  state.clear();
}
