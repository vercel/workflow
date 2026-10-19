/**
 * Sender authentication for self-hosted queue deliveries.
 *
 * world-local and world-postgres deliver queue messages by POSTing them to the
 * app's own flow route (or a route registered with `registerRoute`). That route
 * is an ordinary HTTP endpoint, so anything that can reach the app can POST a
 * well-formed `x-vqs-*` request to it. A delivery decides which workflow runs,
 * which step executes, and (on a first delivery) what run gets created, so it
 * must come from a sender this deployment trusts.
 *
 * The contract is a shared secret, {@link QUEUE_SECRET_ENV}, configured
 * identically on every process that sends or receives queue deliveries:
 *
 * - The sender attaches it to every delivery it makes, HTTP and in-process,
 *   in {@link QUEUE_AUTH_HEADER}. It is added at delivery time and never
 *   stored with the message.
 * - The receiver checks it before parsing headers or reading the body, so an
 *   unauthenticated request never reaches deserialization, run creation, or
 *   execution.
 *
 * With no secret configured, the receiver fails closed (HTTP 503) unless
 * `NODE_ENV` is `development` or `test`, where unauthenticated deliveries are
 * accepted so `next dev` and unit tests need no setup. A configured secret is
 * always enforced, whatever `NODE_ENV` says.
 *
 * world-vercel does not use this module: VQS delivers to the deployment
 * through its own callback transport.
 *
 * Node builtins are imported here, so this module is reached by subpath
 * (`@workflow/world/queue-auth.js`) and is not re-exported from the package
 * index (see `node-http.ts` for why).
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Environment variable holding the shared queue delivery secret. */
export const QUEUE_SECRET_ENV = 'WORKFLOW_QUEUE_SECRET';

/** Request header that carries the queue delivery credential. */
export const QUEUE_AUTH_HEADER = 'x-workflow-queue-auth';

/** Shortest secret the receiver accepts. 32 bytes of hex is 64 characters. */
export const QUEUE_SECRET_MIN_LENGTH = 32;

const SCHEME = 'Bearer ';

/**
 * The configured secret: the explicit World option when given, else
 * {@link QUEUE_SECRET_ENV}, read at call time so a late-set variable is seen.
 * An empty string counts as unset.
 */
export function resolveQueueSecret(configured?: string): string | undefined {
  const secret = configured ?? process.env[QUEUE_SECRET_ENV];
  return secret ? secret : undefined;
}

/**
 * Whether an unconfigured receiver may accept unauthenticated deliveries.
 * Only an explicit `development` or `test` `NODE_ENV` qualifies; an unset
 * `NODE_ENV` is treated as a deployment.
 */
export function allowsUnauthenticatedQueueDelivery(): boolean {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

/**
 * Apply the delivery credential to an outgoing delivery's headers. Any copy of
 * {@link QUEUE_AUTH_HEADER} already present (for example from caller-supplied
 * `QueueOptions.headers`) is removed first, so only the configured secret is
 * ever sent.
 */
export function applyQueueAuthHeader(
  headers: Headers,
  secret: string | undefined
): void {
  headers.delete(QUEUE_AUTH_HEADER);
  if (secret) headers.set(QUEUE_AUTH_HEADER, `${SCHEME}${secret}`);
}

const digest = (value: string) => createHash('sha256').update(value).digest();

const WarnedKey = Symbol.for('@workflow/world//queueAuthWarned/v1');
const globalStore = globalThis as typeof globalThis &
  Record<symbol, Set<string> | undefined>;
// Process-wide rather than per module copy (see env-config.ts).
// biome-ignore lint/suspicious/noAssignInExpressions: off-module state idiom
const warned = (globalStore[WarnedKey] ??= new Set<string>());

function logOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`[workflow] ${message}`);
}

/**
 * Check a delivery's credential before anything else reads the request.
 * Returns `undefined` when the delivery may proceed, or the response to send
 * instead. Never reads the request body.
 *
 * The rejection body never echoes the presented or configured credential.
 */
export function authorizeQueueDelivery(
  req: Request,
  configuredSecret?: string
): Response | undefined {
  const secret = resolveQueueSecret(configuredSecret);

  if (!secret) {
    if (allowsUnauthenticatedQueueDelivery()) return undefined;
    const detail =
      `Queue delivery authentication is not configured. Set ${QUEUE_SECRET_ENV} to the same ` +
      `random value (at least ${QUEUE_SECRET_MIN_LENGTH} characters, for example \`openssl rand -hex 32\`) ` +
      'on every process that sends or receives workflow queue messages. Unauthenticated ' +
      'deliveries are accepted only when NODE_ENV is "development" or "test".';
    logOnce('unconfigured', detail);
    return Response.json(
      { error: 'Queue authentication not configured', detail },
      { status: 503 }
    );
  }

  if (secret.length < QUEUE_SECRET_MIN_LENGTH) {
    const detail = `${QUEUE_SECRET_ENV} is shorter than ${QUEUE_SECRET_MIN_LENGTH} characters; use a longer random value.`;
    logOnce('short', detail);
    return Response.json(
      { error: 'Queue authentication misconfigured', detail },
      { status: 503 }
    );
  }

  const presented = req.headers.get(QUEUE_AUTH_HEADER);
  // Compare fixed-length digests so neither the comparison's duration nor an
  // early length check reveals anything about the secret.
  if (
    presented === null ||
    !presented.startsWith(SCHEME) ||
    !timingSafeEqual(digest(presented.slice(SCHEME.length)), digest(secret))
  ) {
    return Response.json(
      {
        error: 'Unauthorized queue delivery',
        detail: `The request did not carry a valid ${QUEUE_AUTH_HEADER} credential. Senders and receivers must share the same ${QUEUE_SECRET_ENV}.`,
      },
      { status: 401 }
    );
  }

  return undefined;
}
