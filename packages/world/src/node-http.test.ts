import { Buffer } from 'node:buffer';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
} from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNodeHttpAgents,
  destroyNodeHttpAgents,
  type NodeHttpAgents,
  nodeHttpFetch,
} from './node-http.js';

type Handler = (
  request: IncomingMessage,
  response: ServerResponse & { req: IncomingMessage }
) => void;

let server: Server | undefined;
let agents: NodeHttpAgents | undefined;

/** Start a loopback origin and return its base URL. */
async function listen(handler: Handler): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Read a request body to a string, the way the loopback handlers need it. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

afterEach(async () => {
  if (agents) {
    destroyNodeHttpAgents(agents);
    agents = undefined;
  }
  if (server) {
    const toClose = server;
    server = undefined;
    toClose.closeAllConnections();
    await new Promise((resolve) => toClose.close(resolve));
  }
});

describe('nodeHttpFetch', () => {
  it('round-trips a GET and exposes the fetch response surface', async () => {
    const base = await listen((_request, response) => {
      response.statusCode = 201;
      response.statusMessage = 'Created';
      response.setHeader('content-type', 'application/json');
      response.setHeader('x-workflow-test', 'present');
      response.end(JSON.stringify({ hello: 'world' }));
    });

    const response = await nodeHttpFetch(`${base}/thing`);

    expect(response.ok).toBe(true);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.get('x-workflow-test')).toBe('present');
    await expect(response.json()).resolves.toEqual({ hello: 'world' });
  });

  it('sends method, headers and a buffered body', async () => {
    let seen: { method?: string; header?: string; body?: string } = {};
    const base = await listen(async (request, response) => {
      seen = {
        method: request.method,
        header: request.headers['x-custom'] as string,
        body: await readBody(request),
      };
      response.end('ok');
    });

    await nodeHttpFetch(base, {
      method: 'POST',
      headers: new Headers({ 'x-custom': 'value' }),
      body: new TextEncoder().encode('payload'),
    });

    expect(seen).toEqual({
      method: 'POST',
      header: 'value',
      body: 'payload',
    });
  });

  // A chunk-encoded body is rejected by some origins that accept a
  // length-delimited one, so the length is always declared up front.
  it('declares content-length rather than chunking the body', async () => {
    let contentLength: string | undefined;
    let transferEncoding: string | undefined;
    const base = await listen((request, response) => {
      contentLength = request.headers['content-length'];
      transferEncoding = request.headers['transfer-encoding'];
      request.resume();
      response.end('ok');
    });

    await nodeHttpFetch(base, { method: 'POST', body: 'twelve chars' });

    expect(contentLength).toBe('12');
    expect(transferEncoding).toBeUndefined();
  });

  // `fetch` advertises and decodes content codings; `node:http` does neither,
  // so the client has to do both or a gzipped origin response reads as bytes.
  it('advertises and decodes gzip', async () => {
    let advertised: string | undefined;
    const base = await listen((request, response) => {
      advertised = request.headers['accept-encoding'];
      response.setHeader('content-encoding', 'gzip');
      response.setHeader('content-type', 'text/plain');
      response.end(gzipSync(Buffer.from('compressed payload')));
    });

    const response = await nodeHttpFetch(base);

    expect(advertised).toContain('gzip');
    await expect(response.text()).resolves.toBe('compressed payload');
    // The coding headers described the wire body, not the one the caller sees.
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
  });

  it('decodes brotli', async () => {
    const base = await listen((_request, response) => {
      response.setHeader('content-encoding', 'br');
      response.end(brotliCompressSync(Buffer.from('brotli payload')));
    });

    const response = await nodeHttpFetch(base);

    await expect(response.text()).resolves.toBe('brotli payload');
  });

  // `content-encoding: deflate` is served both as a zlib stream and as a bare
  // DEFLATE one, and `fetch` decodes either. Reading the second with an
  // inflater that expects a zlib header fails it with Z_DATA_ERROR.
  it.each([
    ['zlib-wrapped', deflateSync],
    ['raw', deflateRawSync],
  ])('decodes %s deflate', async (_shape, compress) => {
    const base = await listen((_request, response) => {
      response.setHeader('content-encoding', 'deflate');
      response.end(compress(Buffer.from('deflated payload')));
    });

    const response = await nodeHttpFetch(base);

    await expect(response.text()).resolves.toBe('deflated payload');
  });

  // Every decoder finishes on a sync flush, so a body cut short of its trailer
  // still yields what did arrive rather than failing as truncated input.
  it('decodes a compressed body whose trailer never arrives', async () => {
    const full = gzipSync(Buffer.from('hello gzip body'));
    const base = await listen((_request, response) => {
      response.setHeader('content-encoding', 'gzip');
      response.end(full.subarray(0, full.length - 4));
    });

    const response = await nodeHttpFetch(base);

    await expect(response.text()).resolves.toBe('hello gzip body');
  });

  it('streams the body incrementally rather than buffering it', async () => {
    let release: (() => void) | undefined;
    const base = await listen(async (_request, response) => {
      response.write('first');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      response.end('second');
    });

    const response = await nodeHttpFetch(base);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    const first = await reader?.read();
    // Arrived while the handler is still parked, so the body is not buffered.
    expect(decoder.decode(first?.value)).toBe('first');

    release?.();

    let rest = '';
    while (true) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      rest += decoder.decode(chunk.value);
    }
    expect(rest).toBe('second');
  });

  // The `Response` constructor throws if handed a body for these, so they have
  // to be recognized before the stream is built.
  it('resolves null-body statuses without a body', async () => {
    const base = await listen((_request, response) => {
      response.statusCode = 204;
      response.end();
    });

    const response = await nodeHttpFetch(base);

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('resolves a HEAD without a body', async () => {
    const base = await listen((_request, response) => {
      response.setHeader('content-length', '42');
      response.end();
    });

    const response = await nodeHttpFetch(base, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('content-length')).toBe('42');
  });

  // The error the caller sees has to be `signal.reason`, because both entry
  // points map an abort by the reason's `name` (`AbortError` vs `TimeoutError`).
  it('rejects with signal.reason when aborted mid-flight', async () => {
    const base = await listen(() => {
      // Never responds: the abort is the only way out.
    });

    const controller = new AbortController();
    const reason = Object.assign(new Error('caller gave up'), {
      name: 'AbortError',
    });
    const pending = nodeHttpFetch(base, { signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  // Aborting after the headers landed cannot reject the already-resolved
  // promise, so the reason has to surface on the body instead. world-vercel's
  // request timeout is one signal for the whole call, headers and body alike.
  it('errors the body stream with signal.reason when aborted mid-body', async () => {
    const base = await listen((_request, response) => {
      response.write('partial');
      // Then stalls: the abort is the only way out.
    });

    const controller = new AbortController();
    const reason = Object.assign(new Error('deadline'), {
      name: 'TimeoutError',
    });
    const response = await nodeHttpFetch(base, { signal: controller.signal });
    const read = response.text();
    controller.abort(reason);

    await expect(read).rejects.toBe(reason);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const base = await listen((_request, response) => response.end('ok'));

    const reason = new Error('already gone');
    await expect(
      nodeHttpFetch(base, { signal: AbortSignal.abort(reason) })
    ).rejects.toBe(reason);
  });

  // ETIMEDOUT is what world-vercel's TRANSIENT_TRANSPORT_ERROR_CODES matches on
  // to classify a stalled request as retryable transport failure.
  it('raises ETIMEDOUT when headers do not arrive in time', async () => {
    const base = await listen(() => {
      // Never sends a status line.
    });

    await expect(
      nodeHttpFetch(base, { headersTimeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  // The deadline the client enforces itself has to reach the reader as its own
  // cause, not as the generic reset a socket teardown otherwise looks like.
  it('errors the body stream when it stalls past the body timeout', async () => {
    const base = await listen((_request, response) => {
      response.write('start');
      // Then stalls forever without ending.
    });

    const response = await nodeHttpFetch(base, { bodyTimeoutMs: 100 });

    await expect(response.text()).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
  });

  // A socket torn down mid-body emits 'close' with no 'end'. Without an
  // explicit error the reader would wait on a stream that can never complete.
  it('errors the body stream when the socket drops mid-body', async () => {
    const base = await listen((request, response) => {
      response.setHeader('content-length', '100');
      response.write('partial');
      setTimeout(() => request.socket.destroy(), 10);
    });

    const response = await nodeHttpFetch(base);

    await expect(response.text()).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
  });

  // Same teardown, one decoder deeper: the reader is attached to the decoder
  // rather than the message, so the failure only arrives if the message
  // forwards it. `pipe()` forwards nothing but 'end'.
  it('errors the body stream when the socket drops mid-compressed-body', async () => {
    const compressed = gzipSync(Buffer.from('a'.repeat(4096)));
    const base = await listen((request, response) => {
      response.setHeader('content-encoding', 'gzip');
      response.setHeader('content-length', String(compressed.length));
      response.write(compressed.subarray(0, 8));
      setTimeout(() => request.socket.destroy(), 10);
    });

    const response = await nodeHttpFetch(base);

    await expect(response.text()).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
  });

  // A deliberate teardown reaches the socket as a plain reset, and has to keep
  // reporting its own cause through the decoder too.
  it('reports the body deadline rather than a reset on a compressed body', async () => {
    const compressed = gzipSync(Buffer.from('a'.repeat(4096)));
    const base = await listen((_request, response) => {
      response.setHeader('content-encoding', 'gzip');
      response.setHeader('content-length', String(compressed.length));
      response.write(compressed.subarray(0, 8));
      // Then stalls forever without sending the rest.
    });

    const response = await nodeHttpFetch(base, { bodyTimeoutMs: 100 });

    await expect(response.text()).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
  });

  it('rejects a connection that cannot be established', async () => {
    // Port 1 on loopback: nothing listens, so connect fails outright.
    await expect(nodeHttpFetch('http://127.0.0.1:1/')).rejects.toMatchObject({
      code: expect.stringMatching(/ECONNREFUSED|EACCES|ECONNRESET/),
    });
  });

  it('refuses a protocol it cannot speak', async () => {
    await expect(nodeHttpFetch('ftp://example.com/x')).rejects.toBeInstanceOf(
      TypeError
    );
  });

  // `readFrames` cancels the body on every early exit specifically to hand the
  // socket back, so a cancel that does not reach the message is a socket lost
  // for good. On a compressed body the reader is attached to the decoder, and
  // destroying a pipe's destination does not touch its source.
  it.each([
    ['identity', (body: Buffer) => ({ headers: {}, body })],
    [
      'gzip',
      (body: Buffer) => ({
        headers: { 'content-encoding': 'gzip' },
        body: gzipSync(body),
      }),
    ],
  ])('releases the socket when a %s body is cancelled mid-read', async (_coding, encode) => {
    let closed: (() => void) | undefined;
    const serverSocketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const base = await listen((_request, response) => {
      response.socket?.on('close', () => closed?.());
      const { headers, body } = encode(Buffer.from('a'.repeat(64 * 1024)));
      response.writeHead(200, { ...headers, 'content-length': '999999999' });
      response.write(body);
      // Then stalls: the body never completes, so only the cancel can end it.
    });

    agents = createNodeHttpAgents({ maxSockets: 1, keepAliveMs: 10_000 });
    const response = await nodeHttpFetch(base, { agents });
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    // Resolves only if the teardown reached the message; a leaked socket
    // leaves the origin's connection open and times the test out instead.
    await serverSocketClosed;
    // maxSockets is 1, so the pool is wedged for good if the socket was not
    // returned. This request cannot be served otherwise.
    const next = await nodeHttpFetch(base, { agents });
    expect(next.status).toBe(200);
    await next.body?.cancel();
  });

  // undici arms `headersTimeout` only once the request is on a socket, so a
  // request queued behind a busy pool must not spend the budget waiting for
  // one — that would be a redelivery the origin did nothing to earn.
  it('does not spend the header deadline waiting for a socket', async () => {
    // Answers instantly, then holds the connection open for 300ms. Every
    // request meets its own deadline comfortably; only the wait for a free
    // socket exceeds it.
    const base = await listen((_request, response) => {
      response.writeHead(200);
      response.write('ok');
      setTimeout(() => response.end(), 300);
    });

    agents = createNodeHttpAgents({ maxSockets: 1, keepAliveMs: 10_000 });
    const first = await nodeHttpFetch(base, { agents, headersTimeoutMs: 100 });
    // Queued behind `first`, whose body is still open, for well past 100ms.
    const queued = nodeHttpFetch(base, { agents, headersTimeoutMs: 100 });

    await expect(first.text()).resolves.toBe('ok');
    const second = await queued;
    expect(second.status).toBe(200);
    await expect(second.text()).resolves.toBe('ok');
  });

  // Keep-alive is the reason the pool exists: without socket reuse every
  // request would pay a fresh connection, which is what the undici agents the
  // flag replaces were configured to avoid.
  it('reuses a keep-alive socket across requests on the shared pool', async () => {
    const sockets = new Set<unknown>();
    const base = await listen((request, response) => {
      sockets.add(request.socket);
      response.end('ok');
    });

    agents = createNodeHttpAgents({ maxSockets: 4, keepAliveMs: 10_000 });
    for (let i = 0; i < 3; i++) {
      const response = await nodeHttpFetch(base, { agents });
      await response.text();
    }

    expect(sockets.size).toBe(1);
  });
});
