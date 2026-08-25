/**
 * Conversion between the Node-flavoured request/response objects NestJS hands
 * a controller (Express or Fastify) and the WHATWG `Request`/`Response` pair
 * the workflow bundles are written against.
 *
 * The workflow routes are a byte pipe. `/flow` carries serialized run state and
 * the webhook route carries whatever a third party sent, so both directions
 * have to preserve bytes exactly: a webhook signed with an HMAC over its raw
 * body only verifies if the body is byte-identical, and a binary response body
 * only survives if it is never decoded to a string.
 */

import { globalSingleton } from '@workflow/utils';

/** Minimal structural view of the Node request objects we accept. */
type NodeRequestLike = {
  method?: string;
  url?: string;
  originalUrl?: string;
  protocol?: string;
  hostname?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  /**
   * Populated by NestJS when the app is created with `{ rawBody: true }`, and
   * by `fastify-raw-body`. The only source that is guaranteed byte-exact.
   */
  rawBody?: unknown;
  /** Fastify wraps the Node request; Express *is* it. */
  raw?: NodeStreamLike & { socket?: { encrypted?: boolean } };
  socket?: { encrypted?: boolean };
} & Partial<NodeStreamLike>;

type NodeStreamLike = {
  readable?: boolean;
  readableEnded?: boolean;
  complete?: boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
};

/** Minimal structural view of the Node response objects we accept. */
type NodeResponseLike = {
  /** Fastify reply. */
  code?: (status: number) => NodeResponseLike;
  header?: (name: string, value: string) => NodeResponseLike;
  send?: (body?: unknown) => unknown;
  /** Express response. */
  status?: (status: number) => NodeResponseLike;
  setHeader?: (name: string, value: string | string[]) => unknown;
  appendHeader?: (name: string, value: string | string[]) => unknown;
  end?: (body?: unknown) => unknown;
};

const METHODS_WITHOUT_BODY = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

/**
 * Latch for the once-per-process re-serialization warning.
 *
 * On `globalThis` rather than at module scope because a bundler can compile
 * this module into the host application's build more than once, and a
 * per-copy latch would print the same paragraph once per layer. The message
 * is identical from every copy, so those repeats are pure noise.
 */
const warnings = globalSingleton(
  '@workflow/nest//requestConversionWarnings',
  1,
  () => ({ reserializedBody: false })
);

/**
 * Reset the once-per-process warning latch. Test-only.
 * @internal
 */
export function resetRequestConversionWarnings(): void {
  warnings.reserializedBody = false;
}

function isFastifyReply(res: NodeResponseLike): boolean {
  return typeof res.code === 'function';
}

function toBytes(value: ArrayBufferView): Uint8Array {
  return new Uint8Array(
    value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength
    ) as ArrayBuffer
  );
}

/**
 * Read an unconsumed Node request stream to completion.
 *
 * This is the branch that runs when no body parser claimed the request's
 * content type. Without it the body is simply lost: `req.body` is `undefined`
 * and the workflow sees an empty payload while the sender gets a 2xx.
 */
async function readStream(stream: NodeStreamLike): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<
    Uint8Array | ArrayBufferView | string
  >) {
    const bytes =
      typeof chunk === 'string'
        ? new TextEncoder().encode(chunk)
        : toBytes(chunk);
    chunks.push(bytes);
    total += bytes.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Whether the underlying socket still has an unread body for us.
 *
 * `complete` is the reliable signal on a Node `IncomingMessage`: it flips to
 * true once the message has been fully received *and read*. A body parser that
 * already drained the stream leaves `complete === true`, so we must not try to
 * read it again and hang.
 */
function hasUnreadStream(stream: NodeStreamLike | undefined): boolean {
  if (!stream) return false;
  if (typeof stream[Symbol.asyncIterator] !== 'function') return false;
  if (stream.complete === true) return false;
  if (stream.readableEnded === true) return false;
  return stream.readable !== false;
}

/**
 * Recover the request body as raw bytes, preferring sources that preserve the
 * bytes the client actually sent.
 *
 * Order matters:
 *  1. `req.rawBody`: the only byte-exact source, opt-in via `{ rawBody: true }`.
 *  2. A `Buffer`/`Uint8Array` body: `express.raw()` / `express.text()` output,
 *     already the original bytes.
 *  3. An unread stream: no parser claimed this content type, so read it.
 *  4. A parsed object: re-serializing is lossy (key order and whitespace are
 *     gone), so it is the last resort and warns once.
 */
async function resolveRequestBody(
  req: NodeRequestLike
): Promise<Uint8Array | undefined> {
  const raw = req.rawBody;
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  if (ArrayBuffer.isView(raw)) return toBytes(raw);

  const body = req.body;
  if (ArrayBuffer.isView(body)) return toBytes(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);

  // A parser may have run and produced `{}` for an empty body; in that case the
  // stream is drained and `hasUnreadStream` correctly declines to read it.
  const stream = req.raw ?? (req as NodeStreamLike);
  if (hasUnreadStream(stream)) {
    const bytes = await readStream(stream);
    return bytes.byteLength > 0 ? bytes : undefined;
  }

  if (body === undefined || body === null) return undefined;

  if (!warnings.reserializedBody) {
    warnings.reserializedBody = true;
    console.warn(
      '[@workflow/nest] A workflow request body had already been parsed into an ' +
        'object by a body parser, so the raw bytes are no longer available and ' +
        'had to be re-serialized with JSON.stringify. Whitespace and key order ' +
        'are not preserved, which breaks webhook signature verification ' +
        '(Stripe, GitHub, Shopify, Slack, ...). Create the app with ' +
        '`NestFactory.create(AppModule, { rawBody: true })` to keep the raw body.'
    );
  }
  return new TextEncoder().encode(JSON.stringify(body));
}

/**
 * Build the absolute URL of the incoming request.
 *
 * `originalUrl` is used in preference to `url` because Express rewrites `url`
 * when the router is mounted, and the webhook handler parses its token out of
 * the pathname.
 */
function resolveUrl(req: NodeRequestLike): string {
  const encrypted =
    req.raw?.socket?.encrypted === true || req.socket?.encrypted === true;
  const protocol = req.protocol ?? (encrypted ? 'https' : 'http');
  const hostHeader = req.headers?.host;
  const host =
    (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) ??
    req.hostname ??
    'localhost';
  const path = req.originalUrl ?? req.url ?? '/';
  return `${protocol}://${host}${path}`;
}

function toHeaders(
  raw: Record<string, string | string[] | undefined> | undefined
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (value === undefined) continue;
    // HTTP/2 pseudo-headers (:method, :path, ...) are not valid in a Headers
    // object and throw if appended.
    if (name.startsWith(':')) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.append(name, value);
    }
  }
  return headers;
}

/**
 * Convert an Express or Fastify request into a WHATWG `Request`.
 */
export async function toWebRequest(req: unknown): Promise<Request> {
  const request = req as NodeRequestLike;
  const method = (request.method ?? 'GET').toUpperCase();
  const headers = toHeaders(request.headers);

  let body: Uint8Array | undefined;
  if (!METHODS_WITHOUT_BODY.has(method)) {
    body = await resolveRequestBody(request);
  }

  // `content-length` is dropped rather than trusted: a parser may have altered
  // the byte count, and undici derives the correct value from the body we pass.
  headers.delete('content-length');

  // `lib` is es2022 here, so the DOM `RequestInit`/`BodyInit` names are not in
  // scope; the init object is assembled untyped and handed to undici's Request.
  const init: Record<string, unknown> = { method, headers };
  if (body !== undefined) init.body = body;

  return new globalThis.Request(
    resolveUrl(request),
    init as ConstructorParameters<typeof globalThis.Request>[1]
  );
}

/**
 * Write a WHATWG `Response` back through an Express or Fastify response.
 *
 * The body is forwarded as bytes. Decoding it to a string first (`.text()`)
 * replaces any byte that is not valid UTF-8 with U+FFFD, which silently
 * corrupts binary webhook responses.
 */
export async function sendWebResponse(
  res: unknown,
  webResponse: Response
): Promise<void> {
  const response = res as NodeResponseLike;
  const body = webResponse.body
    ? new Uint8Array(await webResponse.arrayBuffer())
    : undefined;

  // `Headers.forEach` yields at most one `set-cookie` entry, so reading cookies
  // that way drops every value but the last. `getSetCookie()` keeps them all.
  const setCookies =
    typeof webResponse.headers.getSetCookie === 'function'
      ? webResponse.headers.getSetCookie()
      : [];

  if (isFastifyReply(response)) {
    response.code?.(webResponse.status);
    webResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') return;
      response.header?.(key, value);
    });
    for (const cookie of setCookies) {
      response.header?.('set-cookie', cookie);
    }
    response.send?.(body === undefined ? undefined : Buffer.from(body));
    return;
  }

  response.status?.(webResponse.status);
  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    response.setHeader?.(key, value);
  });
  if (setCookies.length > 0) {
    response.setHeader?.('set-cookie', setCookies);
  }
  // `end()` rather than `send()`: Express's `send()` appends a charset to the
  // content type and can re-encode the payload.
  response.end?.(body === undefined ? undefined : Buffer.from(body));
}

/**
 * Send a plain status-only response without going through a WHATWG `Response`.
 * Used for the error and not-found paths, where there is no bundle output.
 */
export function sendStatus(
  res: unknown,
  status: number,
  body = '',
  contentType?: string
): void {
  const response = res as NodeResponseLike;
  if (isFastifyReply(response)) {
    if (contentType) response.header?.('content-type', contentType);
    response.code?.(status).send?.(body);
    return;
  }
  if (contentType) response.setHeader?.('content-type', contentType);
  response.status?.(status);
  response.end?.(body);
}
