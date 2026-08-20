import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetRequestConversionWarnings,
  sendStatus,
  sendWebResponse,
  toWebRequest,
} from './request-response.js';

/**
 * Stand-in for an Express request. `body` mirrors whatever a body parser left
 * behind, and `bodyStream` is the unconsumed socket for the cases where no
 * parser claimed the content type.
 */
function expressRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: unknown;
  bodyStream?: string | Uint8Array;
}) {
  const stream =
    options.bodyStream === undefined
      ? undefined
      : Readable.from([
          typeof options.bodyStream === 'string'
            ? Buffer.from(options.bodyStream)
            : Buffer.from(options.bodyStream),
        ]);
  const req = stream ?? (Readable.from([]) as Readable);
  // A drained request has `complete === true`; an unread one does not.
  Object.assign(req, {
    method: options.method ?? 'POST',
    url: options.url ?? '/.well-known/workflow/v1/webhook/tok',
    originalUrl: options.url ?? '/.well-known/workflow/v1/webhook/tok',
    protocol: 'http',
    headers: { host: 'example.test', ...options.headers },
    body: options.body,
    rawBody: options.rawBody,
    complete: options.bodyStream === undefined,
  });
  return req as unknown;
}

function expressResponse() {
  const state = {
    status: 0,
    headers: new Map<string, string | string[]>(),
    body: undefined as Buffer | undefined,
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    setHeader(name: string, value: string | string[]) {
      state.headers.set(name.toLowerCase(), value);
    },
    end(body?: unknown) {
      state.body = body as Buffer | undefined;
    },
  };
  return { res, state };
}

function fastifyReply() {
  const state = {
    status: 0,
    headers: [] as Array<[string, string]>,
    body: undefined as unknown,
  };
  const reply = {
    code(status: number) {
      state.status = status;
      return reply;
    },
    header(name: string, value: string) {
      state.headers.push([name.toLowerCase(), value]);
      return reply;
    },
    send(body?: unknown) {
      state.body = body;
    },
  };
  return { reply, state };
}

async function bodyOf(request: Request): Promise<Uint8Array> {
  return new Uint8Array(await request.arrayBuffer());
}

describe('toWebRequest body fidelity', () => {
  beforeEach(() => {
    resetRequestConversionWarnings();
    vi.restoreAllMocks();
  });

  it('preserves the exact bytes when rawBody is available', async () => {
    // A webhook signed over its raw body only verifies if the bytes survive
    // byte-for-byte, including the whitespace a sender chose.
    const raw = '{"message": "one",\n  "n": 1}';
    const request = await toWebRequest(
      expressRequest({
        headers: { 'content-type': 'application/json' },
        rawBody: Buffer.from(raw),
        body: { message: 'one', n: 1 },
      })
    );
    expect(await request.text()).toBe(raw);
  });

  it('reads an unconsumed stream when no parser claimed the content type', async () => {
    // Previously this body was dropped entirely and the sender still got a 2xx.
    const xml = '<order id="7"><total>19.99</total></order>';
    const request = await toWebRequest(
      expressRequest({
        headers: { 'content-type': 'application/xml' },
        body: undefined,
        bodyStream: xml,
      })
    );
    expect(await request.text()).toBe(xml);
  });

  it('passes a Buffer body through without JSON-encoding it', async () => {
    // express.raw() yields a Buffer; JSON.stringify turns it into
    // {"type":"Buffer","data":[...]} and corrupts the payload.
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const request = await toWebRequest(
      expressRequest({
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from(bytes),
      })
    );
    expect(await bodyOf(request)).toEqual(bytes);
  });

  it('passes a string body through unchanged', async () => {
    const text = 'plain text body, not json at all';
    const request = await toWebRequest(
      expressRequest({ headers: { 'content-type': 'text/plain' }, body: text })
    );
    expect(await request.text()).toBe(text);
  });

  it('re-serializes a parsed object as a last resort and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const make = () =>
      toWebRequest(
        expressRequest({
          headers: { 'content-type': 'application/json' },
          body: { a: 1 },
        })
      );
    expect(await (await make()).text()).toBe('{"a":1}');
    await make();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('rawBody: true');
  });

  it('does not read a body for methods that cannot carry one', async () => {
    const request = await toWebRequest(
      expressRequest({ method: 'HEAD', body: { a: 1 } })
    );
    expect(request.method).toBe('HEAD');
    expect(request.body).toBeNull();
  });

  it('treats a drained parser result of {} as an empty body', async () => {
    // express.json() produces `{}` for an empty body. Re-serializing that would
    // invent a two-byte payload the sender never sent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = await toWebRequest(
      expressRequest({
        headers: { 'content-type': 'application/json' },
        body: {},
        bodyStream: '',
      })
    );
    expect(await request.text()).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops content-length so it cannot disagree with the forwarded body', async () => {
    const request = await toWebRequest(
      expressRequest({
        headers: { 'content-type': 'text/plain', 'content-length': '9999' },
        body: 'short',
      })
    );
    expect(request.headers.get('content-length')).toBeNull();
  });
});

describe('toWebRequest headers and url', () => {
  it('keeps repeated headers instead of collapsing them', async () => {
    const request = await toWebRequest(
      expressRequest({
        headers: { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] },
        body: 'x',
      })
    );
    expect(request.headers.get('x-forwarded-for')).toBe('1.1.1.1, 2.2.2.2');
  });

  it('skips HTTP/2 pseudo-headers, which Headers rejects', async () => {
    const request = await toWebRequest(
      expressRequest({
        headers: { ':method': 'POST', ':path': '/x', 'x-real': 'yes' },
        body: 'x',
      })
    );
    expect(request.headers.get('x-real')).toBe('yes');
  });

  it('builds the url from originalUrl so a mounted router keeps the token', async () => {
    const request = await toWebRequest(
      expressRequest({
        url: '/.well-known/workflow/v1/webhook/tok-123',
        body: 'x',
      })
    );
    expect(new URL(request.url).pathname).toBe(
      '/.well-known/workflow/v1/webhook/tok-123'
    );
  });
});

describe('sendWebResponse', () => {
  it('forwards binary bodies without utf-8 replacement', async () => {
    // `.text()` turns any invalid utf-8 byte into U+FFFD, so a four-byte body
    // used to arrive as eight bytes of replacement characters.
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    const { res, state } = expressResponse();
    await sendWebResponse(res, new Response(bytes, { status: 200 }));
    expect(state.status).toBe(200);
    expect(new Uint8Array(state.body as Buffer)).toEqual(bytes);
  });

  it('keeps every set-cookie value', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');
    const { res, state } = expressResponse();
    await sendWebResponse(res, new Response('ok', { headers }));
    expect(state.headers.get('set-cookie')).toEqual([
      'a=1; Path=/',
      'b=2; Path=/',
    ]);
  });

  it('copies the status and other headers through', async () => {
    const { res, state } = expressResponse();
    await sendWebResponse(
      res,
      new Response('nope', {
        status: 402,
        headers: { 'content-type': 'text/plain' },
      })
    );
    expect(state.status).toBe(402);
    expect(state.headers.get('content-type')).toBe('text/plain');
    expect(state.body?.toString()).toBe('nope');
  });

  it('uses the Fastify reply api when given a reply', async () => {
    const headers = new Headers({ 'content-type': 'text/plain' });
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    const { reply, state } = fastifyReply();
    await sendWebResponse(reply, new Response('hi', { status: 201, headers }));
    expect(state.status).toBe(201);
    expect(state.headers).toEqual([
      ['content-type', 'text/plain'],
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ]);
    expect((state.body as Buffer).toString()).toBe('hi');
  });

  it('sends no body for a bodyless response', async () => {
    const { res, state } = expressResponse();
    await sendWebResponse(res, new Response(null, { status: 204 }));
    expect(state.status).toBe(204);
    expect(state.body).toBeUndefined();
  });
});

describe('sendStatus', () => {
  it('writes a status and body on an Express response', () => {
    const { res, state } = expressResponse();
    sendStatus(res, 503, 'nope');
    expect(state.status).toBe(503);
    expect(state.body).toBe('nope');
  });

  it('sets a content type when given one', () => {
    const { res, state } = expressResponse();
    sendStatus(res, 200, '{}', 'application/json');
    expect(state.headers.get('content-type')).toBe('application/json');
  });

  it('writes a status and body on a Fastify reply', () => {
    const { reply, state } = fastifyReply();
    sendStatus(reply, 404);
    expect(state.status).toBe(404);
    expect(state.body).toBe('');
  });
});
