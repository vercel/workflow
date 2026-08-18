/**
 * A `fetch`-shaped client built on Node's core HTTP modules.
 *
 * `node:http` / `node:https` sit directly on `node:net` / `node:tls`, so a
 * request issued here involves no undici at all: not the adapter's own
 * `Agent`, and not the one behind the runtime's global `fetch`. That is the
 * whole point of this module: it is the transport
 * {@link ./node-http-flag.js | WORKFLOW_NODE_HTTP} selects, for a deployment
 * where undici is not a usable dependency (a bundler that mangles its
 * `node:http2` require, a runtime that ships no working copy of it).
 *
 * The returned value is a platform `Response` built around a streaming body,
 * so every consumer shape the Worlds use keeps working: `text()`, `json()`,
 * `arrayBuffer()`, and reading `body` as a `ReadableStream` / async iterable
 * while the response is still arriving.
 *
 * Node builtins are imported statically here, which is why this module is
 * reached by subpath (`@workflow/world/node-http.js`) and is deliberately not
 * re-exported from the package index: `@workflow/world` is also consumed by
 * browser bundles that must not pull `node:https` into their graph.
 */

import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
import { Transform, type TransformCallback } from 'node:stream';
import zlib from 'node:zlib';

/**
 * Keep-alive connection pools, one per scheme. Mirrors the role of an undici
 * `Agent`: a caller builds a pair once and hands it to every request that
 * should share its sockets.
 */
export interface NodeHttpAgents {
  http: http.Agent;
  https: https.Agent;
}

export interface NodeHttpAgentOptions {
  /** Max concurrent sockets per origin. Mirrors undici's `connections`. */
  maxSockets: number;
  /** How long an idle socket is kept. Mirrors undici's `keepAliveTimeout`. */
  keepAliveMs: number;
}

/**
 * Build a keep-alive pool pair. Both schemes are created up front because the
 * scheme is a property of each request URL, not of the pool: a local queue
 * delivering to `http://localhost` and a World talking to an `https://` origin
 * both go through {@link nodeHttpFetch}.
 */
export function createNodeHttpAgents(
  options: NodeHttpAgentOptions
): NodeHttpAgents {
  const shared = {
    keepAlive: true,
    keepAliveMsecs: options.keepAliveMs,
    maxSockets: options.maxSockets,
  };
  return { http: new http.Agent(shared), https: new https.Agent(shared) };
}

/** Close both pools and drop their idle sockets. */
export function destroyNodeHttpAgents(agents: NodeHttpAgents): void {
  agents.http.destroy();
  agents.https.destroy();
}

export interface NodeHttpFetchInit {
  method?: string;
  headers?: Headers;
  /** Fully-buffered request body. Streaming uploads are not supported. */
  body?: Uint8Array | string | null;
  /** Composed caller/timeout signal. Rejects with `signal.reason`, like `fetch`. */
  signal?: AbortSignal;
  /** Connection pool to dispatch on. Omitted means Node's global agent. */
  agents?: NodeHttpAgents;
  /**
   * Give up if response headers do not arrive within this many ms. `0` or
   * omitted means no deadline, matching undici's `headersTimeout`.
   */
  headersTimeoutMs?: number;
  /**
   * Give up after this many ms with no progress on the response body. `0` or
   * omitted means no deadline, matching undici's `bodyTimeout`.
   */
  bodyTimeoutMs?: number;
}

/**
 * Statuses the `Response` constructor refuses to pair with a body. Node hands
 * back an already-empty message for these, so the stream is drained and
 * discarded rather than wrapped.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Content codings this client advertises. `fetch` negotiates and transparently
 * decodes compression, so the shim has to as well or an origin that compresses
 * by default would hand callers bytes they cannot parse. Deliberately excludes
 * `zstd`, which `node:zlib` only decodes on newer Node versions.
 */
const ACCEPTED_ENCODINGS = 'gzip, deflate, br';

/** Transport failure codes this module raises on its own timers. */
const TIMEOUT_CODE = 'ETIMEDOUT';

function transportError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function toOutgoingHeaders(
  headers: Headers | undefined
): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  headers?.forEach((value, name) => {
    outgoing[name] = value;
  });
  return outgoing;
}

function toResponseHeaders(message: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.append(name, value);
    }
  }
  return headers;
}

/** A Node readable that can also be torn down (both `IncomingMessage` and the zlib decoders are). */
type DestroyableReadable = NodeJS.ReadableStream & {
  destroy?: (error?: Error) => void;
};

/**
 * Finish on a sync flush rather than the strict default, so a body whose
 * trailer never arrives still yields the bytes that did. `fetch` decodes such a
 * response; the strict default rejects it as truncated input.
 */
const ZLIB_OPTIONS: zlib.ZlibOptions = {
  flush: zlib.constants.Z_SYNC_FLUSH,
  finishFlush: zlib.constants.Z_SYNC_FLUSH,
};

const BROTLI_OPTIONS: zlib.BrotliOptions = {
  flush: zlib.constants.BROTLI_OPERATION_FLUSH,
  finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
};

/**
 * `content-encoding: deflate` is served two ways: as a zlib stream (RFC 1950),
 * which carries a two-byte header, and as a bare DEFLATE stream (RFC 1951),
 * which does not. `createInflate` reads only the first and fails the second
 * with `Z_DATA_ERROR`, so the method is picked from the leading byte, the same
 * sniff `fetch` performs.
 *
 * Decoded output is pushed as it arrives without consulting the return value,
 * so a consumer that stops reading buffers the inflated body rather than
 * stalling the socket. Only this coding is affected: the other decoders are
 * piped, and pause their source normally.
 */
class InflateAuto extends Transform {
  private inner?: zlib.Inflate | zlib.InflateRaw;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (!this.inner) {
      if (chunk.length === 0) {
        callback();
        return;
      }
      // RFC 1950 puts the compression method in the low nibble of the first
      // byte, and DEFLATE is 8. Any other value cannot be a zlib header.
      const inner =
        (chunk[0] & 0x0f) === 0x08
          ? zlib.createInflate(ZLIB_OPTIONS)
          : zlib.createInflateRaw(ZLIB_OPTIONS);
      inner.on('data', (decoded: Buffer) => this.push(decoded));
      inner.on('end', () => this.push(null));
      inner.on('error', (error: Error) => this.destroy(error));
      this.inner = inner;
    }
    this.inner.write(chunk, callback);
  }

  /**
   * Overriding `_final` keeps the readable side open past the end of the
   * writable one, so the last inflated bytes still reach the consumer. It is
   * closed by the inner stream's `end`, or here when there was no body at all.
   */
  override _final(callback: (error?: Error | null) => void): void {
    if (this.inner) {
      this.inner.end();
    } else {
      this.push(null);
    }
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this.inner?.destroy();
    callback(error);
  }
}

/**
 * Wrap the response in a decompressor when the origin applied a content
 * coding. `fetch` advertises `accept-encoding` and decodes transparently;
 * `node:http` does neither, so both halves are done by hand here.
 */
function decodeBody(message: http.IncomingMessage): DestroyableReadable {
  const encoding = message.headers['content-encoding']?.toLowerCase().trim();
  if (!encoding || encoding === 'identity') return message;

  let decoder: zlib.Gunzip | InflateAuto | zlib.BrotliDecompress;
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    decoder = zlib.createGunzip(ZLIB_OPTIONS);
  } else if (encoding === 'deflate') {
    decoder = new InflateAuto();
  } else if (encoding === 'br') {
    decoder = zlib.createBrotliDecompress(BROTLI_OPTIONS);
  } else {
    return message;
  }

  // `pipe()` ends the decoder on 'end' and forwards nothing else, so a message
  // torn down mid-body has to be forwarded by hand or the decoder stays open
  // and its reader waits on a stream that can never complete. Node destroys the
  // message with ECONNRESET in that case, which 'error' carries; 'close' is the
  // backstop for a teardown that skips it, mirroring the one `toWebStream`
  // keeps on the undecoded path.
  message.on('error', (error) => decoder.destroy(error));
  message.on('close', () => {
    if (message.complete) return;
    decoder.destroy(transportError('socket hang up', 'ECONNRESET'));
  });
  // `pipe()` forwards the message's teardown to the decoder but not the
  // reverse: destroying the decoder (a reader cancelling mid-body, or the
  // decoder erroring on corrupt input) leaves the message and its socket alive
  // with nobody reading them, so the socket never returns to the agent pool
  // and the pool wedges once `maxSockets` are stranded. Forward the decoder's
  // teardown back to the message so releasing the decoded stream releases the
  // socket. A cleanly-finished message is already complete, so it is left
  // alone to be reused by keep-alive.
  decoder.on('close', () => {
    if (!message.complete) message.destroy();
  });
  return message.pipe(decoder);
}

/**
 * Adapt a Node readable to a web `ReadableStream`, preserving backpressure:
 * the source is paused once the queue is full and resumed on `pull`, so a slow
 * consumer throttles the socket instead of buffering the whole body in memory.
 */
function toWebStream(
  source: DestroyableReadable,
  hooks: { progress(): void; done(): void; failure(cause?: Error): Error }
): ReadableStream<Uint8Array> {
  let closed = false;
  const finish = (fn: () => void) => {
    if (closed) return;
    closed = true;
    hooks.done();
    fn();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on('data', (chunk: Buffer) => {
        hooks.progress();
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.on('end', () => finish(() => controller.close()));
      source.on('error', (error) =>
        finish(() => controller.error(hooks.failure(error)))
      );
      // A socket torn down mid-body emits 'close' without 'end', and does not
      // always deliver the reason on 'error' first. Without this the reader
      // would wait forever on a stream that can never complete.
      source.on('close', () => finish(() => controller.error(hooks.failure())));
    },
    pull() {
      source.resume();
    },
    cancel(reason) {
      finish(() => {});
      source.destroy?.(reason instanceof Error ? reason : undefined);
    },
  });
}

/**
 * Issue one request over Node's core HTTP client and resolve with a platform
 * `Response`.
 *
 * Differences from `fetch` that callers here rely on not mattering: redirects
 * are not followed (every Worlds endpoint answers directly), the request body
 * must be fully buffered, and no cookie or cache handling is applied.
 */
export function nodeHttpFetch(
  url: string,
  init: NodeHttpFetchInit = {}
): Promise<Response> {
  const {
    method = 'GET',
    headers,
    body,
    signal,
    agents,
    headersTimeoutMs,
    bodyTimeoutMs,
  } = init;

  const target = new URL(url);
  const secure = target.protocol === 'https:';
  if (!secure && target.protocol !== 'http:') {
    return Promise.reject(
      new TypeError(
        `node:http transport cannot request ${target.protocol}// URLs`
      )
    );
  }

  const outgoing = toOutgoingHeaders(headers);
  const payload =
    body == null
      ? undefined
      : typeof body === 'string'
        ? Buffer.from(body, 'utf8')
        : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  // Set explicitly so the request is not chunk-encoded: some origins reject a
  // chunked body that `fetch` would have sent with a length.
  if (payload) outgoing['content-length'] = String(payload.byteLength);
  if (!('accept-encoding' in outgoing)) {
    outgoing['accept-encoding'] = ACCEPTED_ENCODINGS;
  }

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    let settled = false;
    let headersTimer: NodeJS.Timeout | undefined;
    let bodyTimer: NodeJS.Timeout | undefined;
    // Set when we tear the request down ourselves (body deadline, caller
    // abort) so the body stream reports that cause rather than the generic
    // reset a socket teardown otherwise looks like.
    let teardownReason: Error | undefined;

    // `clearTimeout` accepts `undefined`, so both timers are cleared without
    // first checking whether they were ever armed.
    const clearTimers = () => {
      clearTimeout(headersTimer);
      clearTimeout(bodyTimer);
      headersTimer = undefined;
      bodyTimer = undefined;
    };

    const request = (secure ? https : http).request(target, {
      method,
      headers: outgoing,
      agent: agents ? (secure ? agents.https : agents.http) : undefined,
    });

    const abort = () => {
      // Destroying the request also tears down an in-flight response body, so
      // this covers an abort raised after the headers arrived.
      if (signal?.reason instanceof Error) teardownReason = signal.reason;
      request.destroy(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });

    const detach = () => {
      signal?.removeEventListener('abort', abort);
    };

    const fail = (error: unknown) => {
      clearTimers();
      detach();
      if (settled) return;
      settled = true;
      reject(error);
    };

    if (headersTimeoutMs) {
      headersTimer = setTimeout(() => {
        request.destroy(
          transportError(
            `no response headers after ${headersTimeoutMs}ms`,
            TIMEOUT_CODE
          )
        );
      }, headersTimeoutMs);
    }

    request.on('error', fail);

    request.on('response', (message) => {
      clearTimeout(headersTimer);
      headersTimer = undefined;

      const status = message.statusCode ?? 0;
      if (status < 200 || status > 599) {
        request.destroy();
        fail(
          transportError(
            `origin returned an unusable status line (${status})`,
            'UNSUPPORTED_STATUS'
          )
        );
        return;
      }

      const responseHeaders = toResponseHeaders(message);
      const statusText = message.statusMessage ?? '';
      const bodiless =
        NULL_BODY_STATUSES.has(status) || method.toUpperCase() === 'HEAD';

      if (bodiless) {
        message.resume();
        clearTimers();
        detach();
        settled = true;
        resolve(
          new Response(null, { status, statusText, headers: responseHeaders })
        );
        return;
      }

      const armBodyTimer = () => {
        if (!bodyTimeoutMs) return;
        clearTimeout(bodyTimer);
        bodyTimer = setTimeout(() => {
          teardownReason = transportError(
            `no response body progress for ${bodyTimeoutMs}ms`,
            TIMEOUT_CODE
          );
          request.destroy(teardownReason);
        }, bodyTimeoutMs);
      };
      armBodyTimer();

      const decoded = decodeBody(message);
      if (decoded !== message) {
        // The body the caller sees is the decoded one, so the coding headers
        // that described the wire body no longer describe it. `fetch` drops
        // both for the same reason.
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
      }

      const stream = toWebStream(decoded, {
        progress: armBodyTimer,
        done: () => {
          clearTimers();
          detach();
        },
        // A deliberate teardown (body deadline, caller abort) reaches the
        // socket as a plain reset, so the reason we tore it down for wins over
        // whatever the socket reported.
        failure: (cause) =>
          teardownReason ??
          cause ??
          transportError('socket hang up', 'ECONNRESET'),
      });

      settled = true;
      resolve(
        new Response(stream, { status, statusText, headers: responseHeaders })
      );
    });

    if (payload) request.write(payload);
    request.end();
  });
}
