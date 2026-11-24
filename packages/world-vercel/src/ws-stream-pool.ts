import { globalSingleton } from '@workflow/utils';
import type { WebSocket } from 'ws';
import { version } from './version.js';
import { beginNormalWsClose } from './ws-stream-connect.js';

/**
 * How long a released stream socket stays available to the next writer of the
 * same run and stream in this process. Each open socket holds a server
 * connection, so the window only needs to span the gap between consecutive
 * steps that write to one stream (an agent's model step and the step after it),
 * not a suspension.
 */
export const STREAM_WS_IDLE_REUSE_MS = 5_000;

/** An open, authenticated v1 stream socket that no writer currently owns. */
export interface IdleStreamSocket {
  ws: WebSocket;
  /** The URL it was opened with, for client spans. */
  wsUrl: string;
  /** The bearer the server captured at the handshake. */
  authorization: string | null;
  /** The next request id to send. v1 only correlates ids, but keep them unique. */
  nextReqId: number;
}

interface IdleEntry extends IdleStreamSocket {
  /** `Date.now()`, so a frozen instance's missed timer is still honored. */
  parkedAt: number;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
}

/**
 * Process-wide, not module-scope: this package is bundled once per bundler
 * layer, and steps of one run may write through different copies. Keyed by
 * package version because the entries are live sockets speaking a protocol
 * whose framing each copy implements itself (see `wsEventsTransports` in
 * `ws-transport.ts`). Two versions keep separate pools.
 */
const poolState = globalSingleton(
  `@workflow/world-vercel//streamWsIdleSockets@${version}`,
  1,
  () => ({ idle: new Map<string, IdleEntry>() })
);

/** One socket can only carry writes for the run and stream in its URL. */
export function streamSocketPoolKey(
  baseUrl: string,
  runId: string,
  name: string
): string {
  return `${baseUrl}\n${runId}\n${name}`;
}

/** Synchronous, so a writer with nothing to reuse pays nothing to find out. */
export function hasIdleStreamSocket(key: string): boolean {
  return poolState.idle.has(key);
}

function retire(key: string, entry: IdleEntry, reason?: string): void {
  if (poolState.idle.get(key) === entry) poolState.idle.delete(key);
  clearTimeout(entry.timer);
  entry.detach();
  if (reason) beginNormalWsClose(entry.ws, reason);
}

/**
 * Keeps an open socket for the next writer of the same stream. The caller must
 * own the socket outright: no request outstanding, no drain in progress, and
 * its own listeners already removed. Any frame on an idle socket (a drain, or a
 * connection-level error) and any close or error retires it, since nothing is
 * outstanding that a later writer could lose.
 */
export function parkIdleStreamSocket(
  key: string,
  socket: IdleStreamSocket
): void {
  const { ws } = socket;
  if (ws.readyState !== 1) {
    beginNormalWsClose(ws, 'stream socket not open at release');
    return;
  }
  const previous = poolState.idle.get(key);
  if (previous) retire(key, previous, 'replaced by a newer idle stream socket');
  const onMessage = () => retire(key, entry, 'stream socket idle message');
  const onEnded = () => retire(key, entry);
  const entry: IdleEntry = {
    ...socket,
    parkedAt: Date.now(),
    timer: setTimeout(
      () => retire(key, entry, 'stream socket idle'),
      STREAM_WS_IDLE_REUSE_MS
    ),
    detach: () => {
      ws.off('message', onMessage);
      ws.off('close', onEnded);
      ws.off('error', onEnded);
    },
  };
  entry.timer.unref?.();
  ws.on('message', onMessage);
  ws.on('close', onEnded);
  ws.on('error', onEnded);
  poolState.idle.set(key, entry);
}

/**
 * Hands the idle socket for `key` to one writer, which then owns it, or returns
 * `undefined`. A socket opened with a different bearer is retired rather than
 * reused, so a writer never sends under an identity it did not resolve itself.
 */
export function takeIdleStreamSocket(
  key: string,
  authorization: string | null
): IdleStreamSocket | undefined {
  const entry = poolState.idle.get(key);
  if (!entry) return undefined;
  if (entry.ws.readyState !== 1) {
    retire(key, entry);
    return undefined;
  }
  if (Date.now() - entry.parkedAt > STREAM_WS_IDLE_REUSE_MS) {
    retire(key, entry, 'stream socket idle');
    return undefined;
  }
  if (entry.authorization !== authorization) {
    retire(key, entry, 'stream socket bearer changed');
    return undefined;
  }
  retire(key, entry);
  return {
    ws: entry.ws,
    wsUrl: entry.wsUrl,
    authorization: entry.authorization,
    nextReqId: entry.nextReqId,
  };
}

/** Closes the idle socket for `key`, if there is one. */
export function discardIdleStreamSocket(key: string, reason: string): void {
  const entry = poolState.idle.get(key);
  if (entry) retire(key, entry, reason);
}

/** Test seam: close and forget every idle socket. */
export function resetIdleStreamSocketsForTest(): void {
  for (const [key, entry] of [...poolState.idle]) {
    retire(key, entry, 'test reset');
  }
}
