import { globalSingleton } from './global-singleton.js';

/**
 * The request header a World's in-process queue attaches to every delivery
 * it sends to the app's queue routes, carrying {@link getQueueAuthKey}. The
 * runtime's flow route compares it against the same key before it does any
 * work (see `authorizeQueueDelivery` in `@workflow/core`).
 */
export const QUEUE_AUTH_HEADER = 'x-workflow-auth';

/** 32 random bytes, base64url: 43 characters. */
const KEY_BYTES = 32;

function generateKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * The process's queue auth key: random, generated on first use, held only in
 * memory and never stored, logged or configured.
 *
 * Process-wide rather than per module copy: the queue that sends a delivery
 * and the route that receives it can sit in different bundler layers of one
 * process (see `globalSingleton`), and both must read the same key. A
 * different process has a different key, so only deliveries sent by this
 * process's own queue are accepted by its routes.
 */
export function getQueueAuthKey(): string {
  return globalSingleton('@workflow/utils//queueAuthKey', 1, () => ({
    key: generateKey(),
  })).key;
}

/**
 * Whether `value` (a delivery's {@link QUEUE_AUTH_HEADER}) is this process's
 * queue auth key. Constant time in the key's contents: the length is not
 * secret, so a value of another length is refused at once.
 */
export function isQueueAuthKey(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const key = getQueueAuthKey();
  if (value.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) {
    diff |= value.charCodeAt(i) ^ key.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Set to `1` on the 401 the runtime answers a delivery with when it does not
 * carry this process's queue key (see `authorizeQueueDelivery` in
 * `@workflow/core`), so the sending queue can tell that refusal apart from a
 * bare 401 from something in front of the app, such as a proxy.
 *
 * The refusal is permanent: inside one process the sender and the route read
 * the same key, so a refused delivery came from another process (or a World
 * that sends no key), and redelivering it can never succeed. A queue that sees
 * the marker gives the message up instead of retrying it.
 */
export const QUEUE_AUTH_REFUSED_HEADER = 'x-workflow-auth-refused';

/** The `code` in the JSON body of that 401. */
export const QUEUE_AUTH_REFUSED_CODE = 'QUEUE_AUTH_REFUSED';

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
