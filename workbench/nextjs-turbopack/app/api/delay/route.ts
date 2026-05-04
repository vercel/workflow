import type { NextRequest } from 'next/server';

/**
 * Test-only delay endpoint. Holds the connection open for `ms` milliseconds
 * before responding. Used by abort-controller e2e tests to verify that an
 * AbortSignal cancels an in-flight `fetch()` call mid-request — the listener
 * path that no other test exercises.
 *
 * Honors the request's own AbortSignal so cancellation closes the connection
 * cleanly instead of running the full delay server-side.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const ms = Math.min(
    Number.parseInt(url.searchParams.get('ms') ?? '5000', 10),
    60_000
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    request.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Client aborted', 'AbortError'));
    });
  });

  return Response.json({ ok: true, waited: ms });
}
