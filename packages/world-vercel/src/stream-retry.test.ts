import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import type { RetryAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStreamDispatcher,
  STREAM_CLOSE_RETRY_OPTIONS,
  STREAM_RETRY_OPTIONS,
} from './http-client.js';
import { encodeMultiChunks } from './stream-chunks.js';
import { createStreamer, writeStreamSessionOverHttp } from './streamer.js';
import type { APIConfig } from './utils.js';

// Use a real loopback origin and Node's global fetch. A fetch mock never wraps
// the materialized append bytes in the one-shot body seen by RetryAgent.
describe('HTTP stream append retries', () => {
  let server: Server;
  let dispatcher: RetryAgent;
  let config: APIConfig;
  let origin: string;
  let attempts: number;
  let rejectedAttempts: number;
  let rejectBeforeBody: boolean;
  let retryAfter: string;
  let failureAfterCommit: number | 'disconnect' | undefined;
  let received: Buffer[];
  let committed: Buffer[];

  function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const attempt = ++attempts;
    const rejected = attempt <= rejectedAttempts;
    const reject = () => {
      res.writeHead(429, { 'Retry-After': retryAfter }).end('rate limited');
    };
    const chunks: Buffer[] = [];
    req.on('error', () => undefined);
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push(body);
      // A confirmed refusal never reaches the fixture's commit path.
      if (rejected) {
        if (!rejectBeforeBody) reject();
        return;
      }
      committed.push(body);
      const failure = committed.length === 1 ? failureAfterCommit : undefined;
      if (failure === 'disconnect') {
        req.socket.destroy();
        return;
      }
      res.writeHead(failure ?? 200).end('response');
    });
    if (rejected && rejectBeforeBody) reject();
  }

  beforeEach(async () => {
    attempts = 0;
    rejectedAttempts = 1;
    rejectBeforeBody = true;
    retryAfter = '0.001';
    failureAfterCommit = undefined;
    received = [];
    committed = [];
    server = createServer(handleRequest);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubEnv('VERCEL_WORKFLOW_SERVER_URL', origin);
    vi.stubEnv('VERCEL_OIDC_TOKEN', undefined);
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
    dispatcher = createStreamDispatcher({
      ...STREAM_RETRY_OPTIONS,
      minTimeout: 1,
      maxTimeout: 20,
      maxRetries: 2,
    });
    config = { token: 'loopback-test-token', dispatcher };
  });

  afterEach(async () => {
    await dispatcher.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  const text = 'Synthetic caf\u00e9 \ud83d\ude00 bytes.';
  const binary = new Uint8Array([99, 0, 255, 128, 1, 99]).subarray(1, 5);

  it('writes a healthy append exactly once', async () => {
    rejectedAttempts = 0;
    await createStreamer(config).streams.write('wrun_test', 'strm_test', text);
    expect(attempts).toBe(1);
    expect(committed).toEqual([Buffer.from(text)]);
  });

  it.each([
    { name: 'UTF-8 string', chunk: text },
    { name: 'binary subarray', chunk: binary },
  ])('replays all bytes of a $name append after 429', async ({ chunk }) => {
    await createStreamer(config).streams.write('wrun_test', 'strm_test', chunk);
    const expected = Buffer.from(chunk);
    expect(attempts).toBe(2);
    expect(received).toEqual([expected, expected]);
    expect(committed).toEqual([expected]);
  });

  it.each([
    'writeMulti',
    'HTTP session',
  ])('replays an entire %s batch after 429', async (operation) => {
    const chunks = [text, binary, ''];
    const expected = Buffer.from(encodeMultiChunks(chunks));
    if (operation === 'writeMulti') {
      await createStreamer(config).streams.writeMulti(
        'wrun_test',
        'strm_test',
        chunks
      );
    } else {
      await writeStreamSessionOverHttp(
        'wrun_test',
        'strm_test',
        chunks,
        config
      );
    }
    expect(attempts).toBe(2);
    expect(received).toEqual([expected, expected]);
    expect(committed).toEqual([expected]);
  });

  it('replays appends larger than the events re-buffering cap', async () => {
    // A stream append has no 1 MiB cap. Refuse after reading this large body so
    // the assertion does not depend on how much was sent before an early 429.
    rejectBeforeBody = false;
    const chunk = new Uint8Array(2 * 1024 * 1024).fill(0xab);
    await createStreamer(config).streams.write('wrun_test', 'strm_test', chunk);
    const expected = Buffer.from(chunk);
    expect(attempts).toBe(2);
    expect(received).toEqual([expected, expected]);
    expect(committed).toEqual([expected]);
  });

  it('bounds repeated 429s and a long Retry-After without committing', async () => {
    rejectedAttempts = Infinity;
    retryAfter = '3600';
    await expect(
      createStreamer(config).streams.write('wrun_test', 'strm_test', text)
    ).rejects.toThrow();
    expect(attempts).toBe(3); // Initial attempt plus maxRetries.
    expect(received).toEqual(
      Array.from({ length: 3 }, () => Buffer.from(text))
    );
    expect(committed).toEqual([]);
  }, 5_000);

  it.each([
    500,
    502,
    503,
    504,
    'disconnect',
  ] as const)('does not replay an append after a possible commit followed by %s', async (failure) => {
    rejectedAttempts = 0;
    failureAfterCommit = failure;
    await expect(
      createStreamer(config).streams.write('wrun_test', 'strm_test', text)
    ).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(committed).toEqual([Buffer.from(text)]);
  });

  it('does not replay an already-buffered append after a lost response', async () => {
    rejectedAttempts = 0;
    failureAfterCommit = 'disconnect';
    // Exercise the retry policy with a replayable body independently of the
    // fetch-body bug, which otherwise masks a duplicate by failing the retry.
    await expect(
      dispatcher.request({
        origin,
        path: '/buffered-append',
        method: 'PUT',
        body: Buffer.from(text),
      })
    ).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(committed).toEqual([Buffer.from(text)]);
  });

  it('retains the separate retry policy for an idempotent stream close', async () => {
    rejectedAttempts = 0;
    failureAfterCommit = 503;
    const closeDispatcher = createStreamDispatcher({
      ...STREAM_CLOSE_RETRY_OPTIONS,
      minTimeout: 1,
      maxTimeout: 20,
      maxRetries: 2,
    });
    try {
      await createStreamer({
        ...config,
        dispatcher: closeDispatcher,
      }).streams.close('wrun_test', 'strm_test');
      expect(attempts).toBe(2);
    } finally {
      await closeDispatcher.close();
    }
  });

  it.each([
    'short',
    'long',
  ])('rejects a %s body before dispatch when its content length is incorrect', async (size) => {
    await expect(
      dispatcher.request({
        origin,
        path: '/invalid-body',
        method: 'PUT',
        headers: { 'content-length': '2' },
        body: (async function* () {
          yield Buffer.from(size === 'short' ? 'a' : 'abc');
        })(),
      })
    ).rejects.toMatchObject({ code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' });
    expect(attempts).toBe(0);
  });

  it('surfaces a body read error without dispatching a partial append', async () => {
    const error = new Error('body read failed');
    await expect(
      dispatcher.request({
        origin,
        path: '/failed-body',
        method: 'PUT',
        headers: { 'content-length': '2' },
        body: (async function* () {
          yield Buffer.from('a');
          throw error;
        })(),
      })
    ).rejects.toBe(error);
    expect(attempts).toBe(0);
  });

  it('reports buffering failures to a v2 dispatcher handler', async () => {
    await expect(
      new Promise((resolve, reject) => {
        dispatcher.dispatch(
          {
            origin,
            path: '/invalid-body',
            method: 'PUT',
            headers: { 'content-length': '2' },
            body: (async function* () {
              yield Buffer.from('a');
            })(),
          },
          {
            onRequestStart: () => undefined,
            onResponseEnd: resolve,
            onResponseError: (_controller, error) => reject(error),
          }
        );
      })
    ).rejects.toMatchObject({ code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' });
    expect(attempts).toBe(0);
  });
});
