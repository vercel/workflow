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
