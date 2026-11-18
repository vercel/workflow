import { globalSingleton } from './global-singleton.js';

/**
 * The request header a World's queue attaches to every delivery it sends to
 * the app's flow route, carrying the app's queue key. The runtime's flow
 * route checks it before it does any work (see `authorizeQueueDelivery` in
 * `@workflow/core`).
 */
export const QUEUE_AUTH_HEADER = 'x-workflow-auth';

/** 32 random bytes, base64url: 43 characters. */
const KEY_BYTES = 32;

/** A key's shape: {@link generateQueueAuthKey}'s output, and nothing else. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A new random queue auth key: 32 random bytes, base64url. */
export function generateQueueAuthKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Whether `value` has the shape of a queue auth key (not whether it is the current one). */
export function isWellFormedQueueAuthKey(
  value: string | null | undefined
): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/**
 * A process-wide key held only in memory, for a World whose queue and routes
 * always share one process (world-sim). The Local World shares its key
 * through its data directory instead; see {@link setQueueAuthKeySource}.
 */
export function getQueueAuthKey(): string {
  return globalSingleton('@workflow/utils//queueAuthKey', 1, () => ({
    key: generateQueueAuthKey(),
  })).key;
}

/**
 * Whether `value` (a delivery's {@link QUEUE_AUTH_HEADER}) equals `expected`,
 * by default the in-memory {@link getQueueAuthKey}. Constant time in the
 * key's contents: the length is not secret, so a value of another length is
 * refused at once.
 */
export function isQueueAuthKey(
  value: string | null | undefined,
  expected: string | undefined = getQueueAuthKey()
): boolean {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  if (value.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= value.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Where the receiving side of this process reads a key a delivery may carry:
 * the key held in memory, and a way to reload it from storage when a
 * delivery carries a different one (another process of the app wrote a new
 * key). Registered by each Local World that generates a key, one per data
 * directory.
 */
export interface QueueAuthKeySource {
  /** The key in memory. No I/O: called on every delivery. */
  current(): string | undefined;
  /** Reloads the key from storage, rate-limited, and returns it. */
  reload(): Promise<string | undefined>;
}

const keySourcesState = () =>
  globalSingleton('@workflow/utils//queueAuthKeySources', 1, () => ({
    sources: new Map<string, QueueAuthKeySource>(),
  }));

/**
 * Registers this process's receiving-side key source for `id` (a data
 * directory), or removes it with `undefined`. Process-wide, so every bundler
 * layer's copy of the route reads the same sources. A process with several
 * Local Worlds on different data directories registers one each, and a
 * delivery carrying any of their keys is accepted. Without any, the
 * receiving side uses the in-memory {@link getQueueAuthKey}.
 */
export function setQueueAuthKeySource(
  id: string,
  source: QueueAuthKeySource | undefined
): void {
  const { sources } = keySourcesState();
  if (source) sources.set(id, source);
  else sources.delete(id);
}

/** Removes every registered key source. For tests: a fresh process. */
export function clearQueueAuthKeySources(): void {
  keySourcesState().sources.clear();
}

/**
 * Whether a delivery's {@link QUEUE_AUTH_HEADER} is the current key of any
 * registered source. Compares against the keys in memory first. Only on a
 * mismatch does it reload the keys from storage (rate-limited by each source)
 * and compare again, so a key another process of the app wrote is accepted
 * without reading storage on every delivery. A delivery without a key
 * reloads too, and is still refused: its sender found no key in storage, and
 * the reload is what puts one back there (the Local World rewrites a key file
 * that is gone).
 */
export async function verifyQueueAuthKey(
  value: string | null | undefined
): Promise<boolean> {
  const { sources } = keySourcesState();
  if (sources.size === 0) return isQueueAuthKey(value);
  for (const source of sources.values()) {
    if (isQueueAuthKey(value, source.current())) return true;
  }
  const reloaded = await Promise.all(
    [...sources.values()].map((source) => source.reload())
  );
  return (
    isWellFormedQueueAuthKey(value) &&
    reloaded.some((key) => isQueueAuthKey(value, key))
  );
}

/**
 * Set to `1` on the 401 the runtime answers a delivery with when it does not
 * carry the app's queue key (see `authorizeQueueDelivery` in
 * `@workflow/core`), so the sending queue can tell that refusal apart from a
 * bare 401 from something in front of the app, such as a proxy.
 *
 * A queue that sees the marker reloads its key, since another process of the
 * app may have written a new one, retries a few times, then gives the message
 * up instead of retrying it for hours. A refused delivery touched no run, so
 * retrying it is safe.
 */
export const QUEUE_AUTH_REFUSED_HEADER = 'x-workflow-auth-refused';

/** The `code` in the JSON body of that 401. */
export const QUEUE_AUTH_REFUSED_CODE = 'QUEUE_AUTH_REFUSED';

/**
 * The `code` in the body of the 403 the runtime answers an HTTP request to
 * the flow route of a World that delivers in process (`queueAuthMode:
 * 'deny'`). Final, unlike {@link QUEUE_AUTH_REFUSED_CODE}: no key would make
 * the route accept the request, so a sender must not retry it.
 */
export const QUEUE_ROUTE_DENIED_CODE = 'QUEUE_ROUTE_DENIED';

/**
 * Whether `response` is the runtime's queue auth refusal: a 401 carrying
 * {@link QUEUE_AUTH_REFUSED_HEADER}. A 401 without it is not, and keeps the
 * queue's ordinary retry behavior.
 */
export function isQueueAuthRefusal(response: {
  status: number;
  headers: Pick<Headers, 'get'>;
}): boolean {
  return (
    response.status === 401 &&
    response.headers.get(QUEUE_AUTH_REFUSED_HEADER) === '1'
  );
}

/**
 * A log limiter: the first call logs at once, later calls at most once per
 * `intervalMs`, each with the number of calls since the last line (itself
 * included). For a condition that can repeat at request rate, such as refused
 * queue deliveries, so it cannot flood the logs. Hold one per long-lived owner
 * (a World's queue, a route), not at module scope.
 *
 * The lines can undercount: calls suppressed after the last line are reported
 * only by the next line, so if none follows they are never logged. Where an
 * exact count matters, count separately; for refused deliveries the
 * `workflow.queue.delivery.refused` counter is the source of truth.
 */
export function createLogLimiter(
  intervalMs = 60_000
): (log: (countSinceLastLog: number) => void) => void {
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return (log) => {
    const now = Date.now();
    if (now - lastLoggedAt < intervalMs) {
      suppressed++;
      return;
    }
    lastLoggedAt = now;
    const count = suppressed + 1;
    suppressed = 0;
    log(count);
  };
}
