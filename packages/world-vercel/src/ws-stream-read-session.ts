import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
} from '@workflow/world';
import { ulid } from 'ulid';
import type { WebSocket } from 'ws';
import { type DecodedFrame, decodeFrames } from './frames.js';
import { headersToRecord, withHttpClientSpan } from './http-core.js';
import { createIndexedStreamFallback } from './indexed-stream-fallback.js';
import {
  encodeStreamReadWsControl,
  getStreamReadWsProtocolV1Url,
  parseStreamReadWsServerFrame,
  type StreamReadWsReaderId,
} from './stream-read-ws-protocol-v1.js';
import { injectTraceContextIntoHeaders } from './telemetry.js';
import type { APIConfig } from './utils.js';
import { getHttpConfig } from './utils.js';

export const STREAM_READ_WS_CONNECT_BUDGET_MS = 250;
export const STREAM_READ_WS_CANCEL_BUDGET_MS = 250;
const MAX_WS_RECONNECTS = 3;
const MAX_RETRY_AFTER_MS = 5_000;
const MAX_OUTSTANDING_CREDIT = 4;

export interface StreamReadFallbacks {
  resolveStartIndex(startIndex: number): Promise<number>;
  getChunks(options: GetChunksOptions): Promise<StreamChunksResponse>;
  getInfo(): Promise<StreamInfoResponse>;
}

async function decodeOne(raw: Uint8Array): Promise<DecodedFrame> {
  let result: DecodedFrame | undefined;
  for await (const frame of decodeFrames(
    (async function* () {
      yield raw;
    })()
  )) {
    if (result) throw new Error('stream read message contains multiple frames');
    result = frame;
  }
  if (!result) throw new Error('stream read message contains no frame');
  return result;
}

function asBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  return new Uint8Array(raw as ArrayBufferLike);
}

export function createStreamReadWsSession(
  runId: string,
  name: string,
  startIndex: number,
  config: APIConfig | undefined,
  fallbacks: StreamReadFallbacks
): ReadableStream<Uint8Array> {
  const readerId = `read_${ulid()}` as StreamReadWsReaderId;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let socket: WebSocket | undefined;
  let started = false;
  let activated = false;
  let opened = false;
  let cancelled = false;
  let terminal = false;
  let expected = startIndex;
  let outstandingCredit = 0;
  let reconnects = 0;
  let inbound = Promise.resolve();
  let httpReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let httpFallback: Promise<void> | undefined;
  let cancelReqId = 1;
  let cancelAck: (() => void) | undefined;
  let pullResolve: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryResolve: (() => void) | undefined;

  const notifyPull = () => {
    const resolve = pullResolve;
    pullResolve = undefined;
    resolve?.();
  };
  const waitForDelivery = () =>
    new Promise<void>((resolve) => {
      pullResolve = resolve;
    });

  const restoreCreditWindow = () => {
    if (!opened || terminal || cancelled || !socket || socket.readyState !== 1)
      return;
    const capacity = Math.max(
      0,
      Math.min(MAX_OUTSTANDING_CREDIT, Math.floor(controller.desiredSize ?? 0))
    );
    const chunks = capacity - outstandingCredit;
    if (chunks <= 0) return;
    socket.send(encodeStreamReadWsControl({ type: 'credit', chunks }));
    outstandingCredit += chunks;
  };

  const closeSocket = (reason: string) => {
    const active = socket;
    socket = undefined;
    active?.close(1000, reason);
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      retryResolve = resolve;
      retryTimer = setTimeout(resolve, ms);
      retryTimer.unref?.();
    }).finally(() => {
      retryTimer = undefined;
      retryResolve = undefined;
    });

  const pumpRawHttpReader = async () => {
    if (!httpReader || cancelled) return;
    const result = await httpReader.read();
    if (result.done) {
      terminal = true;
      controller.close();
      notifyPull();
      return;
    }
    controller.enqueue(result.value);
    notifyPull();
  };

  const switchToHttp = (): Promise<void> => {
    if (cancelled || terminal) return Promise.resolve();
    // Claim fallback synchronously. Timeout/error/close/decline callbacks all
    // join this one transition and can never open competing HTTP readers.
    httpFallback ??= (async () => {
      closeSocket('HTTP fallback');
      if (!activated) {
        expected = await fallbacks.resolveStartIndex(startIndex);
        activated = true;
      }
      if (cancelled || terminal) return;
      httpReader = createIndexedStreamFallback(expected, fallbacks).getReader();
      await pumpRawHttpReader();
    })();
    return httpFallback;
  };

  const recover = async (retryAfterMs = 0) => {
    closeSocket('recovering stream read');
    opened = false;
    outstandingCredit = 0;
    if (retryAfterMs > 0) {
      await wait(Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
    }
    if (cancelled || terminal) return;
    if (reconnects++ >= MAX_WS_RECONNECTS) {
      await switchToHttp();
      return;
    }
    await safeConnect(expected);
  };

  const handleFrame = async (raw: Uint8Array) => {
    const frame = await decodeOne(raw);
    const { meta, body } = parseStreamReadWsServerFrame(frame.meta, frame.body);
    if (cancelled && meta.type !== 'cancel_ack') return;
    if (meta.type === 'opened') {
      if (opened || meta.requestedStartIndex !== expected) {
        throw new Error('unexpected stream read opened frame');
      }
      activated = true;
      opened = true;
      expected = meta.resolvedStartIndex;
      outstandingCredit = 1;
      restoreCreditWindow();
      return;
    }
    // Initialization may fail before a position can be opened.
    if (meta.type === 'error') {
      terminal = true;
      closeSocket('fatal stream read error');
      controller.error(
        new Error(
          `stream read failed (${meta.status}/${meta.code}): ${meta.message ?? ''}`
        )
      );
      notifyPull();
      return;
    }
    if (!opened)
      throw new Error(`stream read ${meta.type} arrived before opened`);
    if (meta.type === 'chunk') {
      outstandingCredit = Math.max(0, outstandingCredit - 1);
      if (meta.index < expected) {
        restoreCreditWindow();
        return;
      }
      if (meta.index > expected) {
        await recover();
        return;
      }
      expected++;
      // The retry budget counts consecutive reconnects without forward
      // progress, not normal rotations over a long-lived reader.
      reconnects = 0;
      controller.enqueue(body);
      restoreCreditWindow();
      notifyPull();
      return;
    }
    if (meta.type === 'eof') {
      if (expected >= meta.nextIndex) {
        terminal = true;
        closeSocket('stream complete');
        controller.close();
        notifyPull();
      } else {
        await recover();
      }
      return;
    }
    if (meta.type === 'end') {
      await recover(meta.retryAfterMs);
      return;
    }
    if (meta.type === 'cancel_ack') {
      if (meta.reqId === cancelReqId - 1) cancelAck?.();
    }
  };

  async function safeConnect(index: number): Promise<void> {
    try {
      await connect(index);
    } catch {
      // Dynamic ws loading, header construction, or any other pre-OPEN failure
      // is safe to decline to the mandatory compatibility transport.
      if (!cancelled && !terminal) await switchToHttp();
    }
  }

  async function connect(index: number): Promise<void> {
    const [{ WebSocket: WebSocketImpl }, http] = await Promise.all([
      import('ws'),
      getHttpConfig(config),
    ]);
    if (cancelled || terminal) return;
    if (http.usingProxy) {
      await switchToHttp();
      return;
    }
    const url = getStreamReadWsProtocolV1Url(
      http.baseUrl,
      runId,
      name,
      index,
      readerId
    );
    await withHttpClientSpan(
      {
        method: 'GET',
        url: url.toString(),
        spanName: 'workflow.stream.read.ws.connect',
      },
      async () => {
        await injectTraceContextIntoHeaders(http.headers);
        if (cancelled || terminal) return;
        const ws = new WebSocketImpl(url, {
          headers: headersToRecord(http.headers),
        });
        socket = ws;
        ws.binaryType = 'nodebuffer';
        let settled = false;
        await new Promise<void>((resolve) => {
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const fallback = () => {
            void switchToHttp().then(finish, (error) => {
              terminal = true;
              finish();
              controller.error(error);
            });
          };
          const timer = setTimeout(() => {
            closeSocket('connect budget expired');
            fallback();
          }, STREAM_READ_WS_CONNECT_BUDGET_MS);
          timer.unref?.();
          ws.once('open', () => {
            if (socket !== ws || cancelled || terminal) {
              ws.close(1000, 'superseded stream reader');
              finish();
              return;
            }
            finish();
          });
          ws.once('unexpected-response', (_request, response) => {
            const res = response as {
              resume?: () => void;
              destroy?: () => void;
            };
            res.resume?.();
            res.destroy?.();
            if (socket === ws) fallback();
            else finish();
          });
          ws.once('error', () => {
            if (socket === ws && !opened) fallback();
          });
          ws.once('close', () => {
            if (!settled) {
              if (socket === ws) fallback();
              else finish();
            } else if (!cancelled && !terminal && socket === ws) {
              void recover().catch((error) => controller.error(error));
            }
          });
          ws.on('message', (raw) => {
            inbound = inbound
              .then(() => {
                // Frames queued before recovery may arrive after a replacement
                // socket owns the logical reader. Only the current attempt may
                // mutate expected or terminate the stream.
                if (socket !== ws || terminal) return;
                return handleFrame(asBytes(raw));
              })
              .catch((error) => {
                terminal = true;
                closeSocket('stream read protocol error');
                controller.error(error);
              });
          });
        });
      }
    );
  }

  const cancel = async (reason?: unknown) => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryResolve?.();
    await httpReader?.cancel(reason).catch(() => undefined);
    if (!socket || socket.readyState !== 1 || !opened) {
      closeSocket('reader cancelled');
      return;
    }
    const reqId = cancelReqId++;
    const acknowledged = new Promise<void>((resolve) => {
      cancelAck = resolve;
    });
    socket.send(
      encodeStreamReadWsControl({
        type: 'cancel',
        reqId,
        ...(typeof reason === 'string' ? { reason } : {}),
      })
    );
    await Promise.race([acknowledged, wait(STREAM_READ_WS_CANCEL_BUDGET_MS)]);
    closeSocket('reader cancelled');
  };

  return new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      async pull() {
        if (terminal || cancelled) return;
        const delivered = waitForDelivery();
        if (!started) {
          started = true;
          await safeConnect(startIndex);
        } else if (httpReader) {
          await pumpRawHttpReader();
        } else if (opened) {
          restoreCreditWindow();
        }
        if (!terminal && !cancelled) await delivered;
      },
      cancel,
    },
    { highWaterMark: MAX_OUTSTANDING_CREDIT }
  );
}
