import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamError } from '@workflow/errors';
import { describe, expect, it, vi } from 'vitest';
import * as httpClient from './http-client.js';
import { instrumentedFetch } from './http-core.js';
import {
  createStreamer,
  encodeMultiChunks,
  writeStreamSessionOverHttp,
} from './streamer.js';

type ReceivedAppend = { request: IncomingMessage; body?: Buffer };

async function withAppendServer(
  reply: (res: ServerResponse, body: Buffer, attempt: number) => void,
  test: (context: {
    origin: string;
    dispatcher: ReturnType<typeof httpClient.createStreamDispatcher>;
    requests: ReceivedAppend[];
  }) => Promise<void>
) {
  const requests: ReceivedAppend[] = [];
  const server = createServer((req, res) => {
    const received: ReceivedAppend = { request: req };
    requests.push(received);
    const attempt = requests.length;
    const chunks: Buffer[] = [];
    req.on('error', () => {});
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.body = Buffer.concat(chunks);
      reply(res, received.body, attempt);
    });
  });
  // One connection also proves a discarded 429 does not hold up the retry.
  const dispatcher = httpClient.createStreamDispatcher(
    httpClient.STREAM_RETRY_OPTIONS,
    { connections: 1 }
  );
  vi.spyOn(httpClient, 'getStreamDispatcher').mockReturnValue(dispatcher);
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubEnv('VERCEL_WORKFLOW_SERVER_URL', origin);
    vi.stubEnv('WORKFLOW_NODE_HTTP', '0');
    await test({ origin, dispatcher, requests });
  } finally {
    await dispatcher.destroy();
    httpClient._resetNodeHttpAgentsForTests();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
}

/** Bound a lifecycle assertion while always allowing the fixture to clean up. */
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('lifecycle did not settle')),
          2000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Reduced from https://github.com/vercel/workflow/issues/4628. Exercise the
// production streamer and dispatcher through real fetch and a loopback server.
describe('HTTP append retry integration', () => {
  it.each([
    { label: 'Unicode', payload: 'Hello, 世界 👋 Привет' },
    { label: 'binary bytes', payload: new Uint8Array([0, 128, 255, 1]) },
    {
      label: 'Buffer view',
      payload: Buffer.from([9, 0, 255, 8]).subarray(1, 3),
    },
    { label: 'empty bytes', payload: new Uint8Array() },
    { label: 'empty string', payload: '' },
    { label: 'over 1 MiB', payload: Buffer.alloc(2 * 1024 * 1024, 0xa5) },
  ])('resends complete $label after the first body has been consumed', async ({
    payload,
  }) => {
    const expected = Buffer.from(
      typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
    );
    const saved: Buffer[] = [];
    await withAppendServer(
      (res, body, attempt) => {
        if (attempt === 1) res.writeHead(429, { 'Retry-After': '0.001' }).end();
        else {
          saved.push(body);
          res.end();
        }
      },
      async ({ requests }) => {
        await createStreamer().streams.write('wrun_test', 'data', payload);
        expect(requests.map(({ body }) => body?.equals(expected))).toEqual([
          true,
          true,
        ]);
        expect(saved.map((body) => body.equals(expected))).toEqual([true]);
      }
    );
  });

  it.each([
    'writeMulti',
    'session',
  ] as const)('retries individual %s pages without resending accepted pages', async (mode) => {
    const chunks = ['first', new Uint8Array([0, 255]), '世界'];
    const pages = [
      Buffer.from(encodeMultiChunks(chunks.slice(0, 2))),
      Buffer.from(encodeMultiChunks(chunks.slice(2))),
    ];
    const saved: Buffer[] = [];
    const onRequestDispatched = vi.fn();
    await withAppendServer(
      (res, body, attempt) => {
        if (attempt === 2) {
          res.writeHead(429, { 'Retry-After': '0.001' }).end();
        } else {
          saved.push(body);
          res.end();
        }
      },
      async ({ requests }) => {
        vi.stubEnv('WORKFLOW_MAX_CHUNKS_PER_REQUEST', '2');
        if (mode === 'session') {
          await writeStreamSessionOverHttp(
            'wrun_test',
            'data',
            chunks,
            undefined,
            undefined,
            onRequestDispatched
          );
          expect(onRequestDispatched).toHaveBeenCalledTimes(1);
        } else {
          const { writeMulti } = createStreamer().streams;
          if (!writeMulti)
            throw new Error('HTTP streamer must implement writeMulti');
          await writeMulti('wrun_test', 'data', chunks);
        }
        expect(requests.map(({ body }) => body)).toEqual([
          pages[0],
          pages[1],
          pages[1],
        ]);
        expect(saved).toEqual(pages);
        expect(
          requests.every(
            ({ request }) => request.headers['x-stream-multi'] === 'true'
          )
        ).toBe(true);
      }
    );
  });

  it('retains the original bytes if the caller changes its Buffer between attempts', async () => {
    const payload = Buffer.from('original');
    const saved: Buffer[] = [];
    await withAppendServer(
      (res, body, attempt) => {
        if (attempt === 1) {
          payload.fill(0);
          res.writeHead(429, { 'Retry-After': '0.001' }).end();
        } else {
          saved.push(body);
          res.end();
        }
      },
      async ({ requests }) => {
        await createStreamer().streams.write('wrun_test', 'data', payload);
        expect(requests.map(({ body }) => body?.toString())).toEqual([
          'original',
          'original',
        ]);
        expect(saved.map((body) => body.toString())).toEqual(['original']);
      }
    );
  });

  it.each([
    '500',
    'socket reset',
  ])('does not duplicate a saved append followed by %s', async (failure) => {
    const saved: Buffer[] = [];
    await withAppendServer(
      (res, body) => {
        saved.push(body);
        if (failure === '500') res.writeHead(500).end('saved, but failed');
        else res.destroy();
      },
      async ({ requests }) => {
        await expect(
          createStreamer().streams.write('wrun_test', 'data', 'Hello')
        ).rejects.toBeInstanceOf(StreamError);
        expect(requests).toHaveLength(1);
        expect(saved).toEqual([Buffer.from('Hello')]);
      }
    );
  });

  it('surfaces a firewall challenge without retrying it', async () => {
    await withAppendServer(
      (res) =>
        res
          .writeHead(429, {
            'Retry-After': '0.001',
            'x-vercel-mitigated': 'challenge',
          })
          .end('challenge'),
      async ({ requests }) => {
        await expect(
          createStreamer().streams.write('wrun_test', 'data', 'Hello')
        ).rejects.toMatchObject({ code: 'STREAM_ERROR', status: 429 });
        expect(requests).toHaveLength(1);
      }
    );
  });

  it('releases an unfinished 429 body before retrying on a single-connection pool', async () => {
    const rejectedClosed = Promise.withResolvers<void>();
    await withAppendServer(
      (res, _body, attempt) => {
        if (attempt === 1) {
          res.on('close', rejectedClosed.resolve);
          res.writeHead(429, { 'Retry-After': '0.001' });
          res.write('never ending diagnostic');
        } else res.end();
      },
      async ({ requests }) => {
        await within(
          createStreamer().streams.write('wrun_test', 'data', 'Hello')
        );
        await within(rejectedClosed.promise);
        expect(requests).toHaveLength(2);
      }
    );
  });

  it('aborts a pending response without resending', async () => {
    const received = Promise.withResolvers<void>();
    await withAppendServer(
      () => received.resolve(),
      async ({ origin, dispatcher, requests }) => {
        const controller = new AbortController();
        const result = instrumentedFetch({
          method: 'PUT',
          url: origin,
          headers: new Headers(),
          body: 'Hello',
          dispatcher,
          retryStreamAppend: true,
          timeoutMs: null,
          signal: controller.signal,
          transportErrorCode: 'STREAM_ERROR',
        }).catch((error: unknown) => error);
        await within(received.promise);
        controller.abort();
        expect(await within(result)).toBeInstanceOf(StreamError);
        expect(requests).toHaveLength(1);
      }
    );
  });

  it.each([
    'write',
    'writeMulti',
    'session',
  ] as const)('leaves a custom dispatcher in control of %s retries', async (mode) => {
    await withAppendServer(
      (res) =>
        res.writeHead(429, { 'Retry-After': '0.001' }).end('custom policy'),
      async ({ dispatcher, requests }) => {
        vi.restoreAllMocks();
        const config = { dispatcher };
        const streams = createStreamer(config).streams;
        if (!streams.writeMulti)
          throw new Error('HTTP streamer must implement writeMulti');
        const result =
          mode === 'session'
            ? writeStreamSessionOverHttp('wrun_test', 'data', ['Hello'], config)
            : mode === 'writeMulti'
              ? streams.writeMulti('wrun_test', 'data', ['Hello'])
              : streams.write('wrun_test', 'data', 'Hello');
        await expect(result).rejects.toMatchObject({
          code: 'STREAM_ERROR',
          status: 429,
        });
        expect(requests).toHaveLength(1);
      }
    );
  });

  it('keeps node:http append behavior without adding another retry layer', async () => {
    await withAppendServer(
      (res) => res.writeHead(429, { 'Retry-After': '0.001' }).end('node:http'),
      async ({ requests }) => {
        vi.restoreAllMocks();
        vi.stubEnv('WORKFLOW_NODE_HTTP', '1');
        await expect(
          createStreamer().streams.write('wrun_test', 'data', 'Hello')
        ).rejects.toMatchObject({ code: 'STREAM_ERROR', status: 429 });
        expect(requests).toHaveLength(1);
      }
    );
  });

  it('retains bodyless close retries for a 503', async () => {
    await withAppendServer(
      (res, _body, attempt) => {
        res
          .writeHead(attempt === 1 ? 503 : 200, { 'Retry-After': '0.001' })
          .end();
      },
      async ({ requests }) => {
        const closeDispatcher = httpClient.createStreamDispatcher(
          httpClient.STREAM_CLOSE_RETRY_OPTIONS
        );
        vi.spyOn(httpClient, 'getStreamCloseDispatcher').mockReturnValue(
          closeDispatcher
        );
        try {
          await createStreamer().streams.close('wrun_test', 'data');
          expect(requests).toHaveLength(2);
          expect(
            requests.every(
              ({ request, body }) =>
                request.headers['x-stream-done'] === 'true' &&
                body?.length === 0
            )
          ).toBe(true);
        } finally {
          await closeDispatcher.destroy();
        }
      }
    );
  });
});
