import type { WebSocket } from 'ws';
import { trace } from './telemetry.js';

/**
 * Initial implementation-level wait for an opted-in stream socket to open.
 * Tune from deployment measurements; this is not protocol semantics.
 */
export const STREAM_WS_CONNECT_BUDGET_MS = 250;
/** Cleanup-only wait after semantic close success; not protocol semantics. */
export const STREAM_WS_CLOSE_BUDGET_MS = 250;

/**
 * Starts a normal close without adding cleanup latency to semantic completion.
 * On Vercel, waitUntil retains the invocation long enough for the handshake.
 */
export function beginNormalWsClose(ws: WebSocket, reason: string): void {
  if (ws.readyState === 3) return;
  let timedOut = false;
  const observed = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, STREAM_WS_CLOSE_BUDGET_MS);
    timer.unref?.();
    ws.once('close', finish);
  });
  const cleanup = trace('workflow.stream.ws.close.cleanup', async (span) => {
    await observed;
    span?.setAttribute('workflow.stream.ws.close_cleanup_timeout', timedOut);
  });
  // Keep @vercel/functions off the module-evaluation path: the core runtime
  // imports World implementations in environments where that peer is mocked
  // or unavailable. Outside a Vercel request context waitUntil is a no-op.
  void import('@vercel/functions')
    .then(({ waitUntil }) => waitUntil(cleanup))
    .catch(() => {});
  void cleanup.catch(() => {});
  ws.close(1000, reason);
}
