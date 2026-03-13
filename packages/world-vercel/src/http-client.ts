import { Agent, RetryAgent } from 'undici';

const debug = process.env.DEBUG === '1';

let _dispatcher: RetryAgent | undefined;

/**
 * Returns a shared undici RetryAgent wrapping an Agent.
 *
 * - Connection pooling (up to 8 connections per origin)
 * - Retry: Automatic retry on 429/5xx or network errors with exponential backoff
 *   - Observes Retry-After header if received and lower than 30s
 *
 * Note: HTTP/2 is disabled because undici's experimental H2 support hangs
 * in certain Vercel runtime environments (sveltekit). HTTP/1.1 pipelining
 * is also disabled (pipelining: 1) because it causes head-of-line blocking
 * that deadlocks the webhook respondWith mechanism. The primary benefits
 * from undici here are retry logic and connection pooling.
 */
export function getDispatcher(): RetryAgent {
  if (!_dispatcher) {
    const maxRetries = 5;
    const minTimeout = 500;
    const maxTimeout = 30_000;
    const timeoutFactor = 2;
    const statusCodes = [500, 502, 503, 504, 429];
    const errorCodes = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ENETDOWN',
      'ENETUNREACH',
      'EHOSTDOWN',
      'EHOSTUNREACH',
      'EPIPE',
      'UND_ERR_SOCKET',
    ];
    const methods = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE'];

    _dispatcher = new RetryAgent(
      new Agent({
        connections: 8,
        keepAliveTimeout: 10_000,
        pipelining: 1,
      }),
      {
        retryAfter: true,
        retry(err, { state, opts }, cb) {
          const { statusCode, code, headers } = err as Error & {
            statusCode?: number;
            code?: string;
            headers?: Record<string, string>;
          };

          if (debug) {
            console.error(
              `[Debug] RetryAgent: ${opts.method} ${opts.origin}${opts.path} → ${statusCode ?? code ?? 'unknown error'} (attempt ${state.counter}/${maxRetries})`
            );
          }

          // Not a retryable error code
          if (
            code &&
            code !== 'UND_ERR_REQ_RETRY' &&
            !errorCodes.includes(code)
          ) {
            cb(err);
            return;
          }

          // Not a retryable method
          if (!methods.includes(opts.method)) {
            cb(err);
            return;
          }

          // Not a retryable status code
          if (statusCode != null && !statusCodes.includes(statusCode)) {
            cb(err);
            return;
          }

          // Max retries exceeded
          if (state.counter > maxRetries) {
            cb(err);
            return;
          }

          // Calculate retry delay (observe Retry-After header)
          let retryAfter = 0;
          if (headers?.['retry-after']) {
            const parsed = Number(headers['retry-after']);
            retryAfter = Number.isNaN(parsed)
              ? Math.max(
                  0,
                  new Date(headers['retry-after']).getTime() - Date.now()
                )
              : parsed * 1000;
          }

          const delay =
            retryAfter > 0
              ? Math.min(retryAfter, maxTimeout)
              : Math.min(
                  minTimeout * timeoutFactor ** (state.counter - 1),
                  maxTimeout
                );

          if (debug) {
            console.error(`[Debug] RetryAgent: retrying in ${delay}ms`);
          }

          setTimeout(() => cb(null), delay);
        },
      }
    );
  }
  return _dispatcher;
}
