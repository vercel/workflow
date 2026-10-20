import {
  FatalError,
  IDEMPOTENCY_KEYS_DISABLED_CODE,
  type WorkflowRunAlreadyStartedError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  IdempotencyKeyConflictPolicy,
  IdempotencyKeyReusePolicy,
  WorkflowInvokePayload,
  World,
} from '@workflow/world';
import {
  getRunQueueNamespace,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_TTL_DEFAULT_MS,
  IDEMPOTENCY_KEY_TTL_MAX_MS,
  IDEMPOTENCY_KEY_TTL_MIN_MS,
  IdempotencyKeyConflictPolicySchema,
  IdempotencyKeyReusePolicySchema,
  isLegacySpecVersion,
  isWellFormedString,
  SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
  workflowRunIdSchema,
} from '@workflow/world';
import type { StringValue } from 'ms';
import ms from 'ms';
import { getWorkflowQueueName } from './helpers.js';
import type { StartOptionsBase } from './start.js';

/**
 * `start({ experimental_idempotencyKey })`: validating the options, refusing
 * starts that cannot honor a key, and adopting the run that holds one. Kept
 * apart from `start()` itself, which only claims the key, adopts the holder,
 * or publishes. See `WorldCapabilities.runIdempotencyKeys` for the contract.
 *
 * Import from here, never re-export through `start.ts`. `start()` is a
 * `'use step'` function that workflow bundles reach through `workflow/api`:
 * the build strips its body there, and the imports only that body uses with
 * it, but an `export … from` would keep this module (and the Node-only code
 * it reaches) in the workflow bundle, which then fails to build.
 */

/** A validated idempotency key with its defaults resolved. */
export interface ResolvedIdempotencyOptions {
  key: string;
  ttlMs: number;
  reusePolicy: IdempotencyKeyReusePolicy;
  conflictPolicy: IdempotencyKeyConflictPolicy;
}

/** Every option that requires `experimental_idempotencyKey`. */
const IDEMPOTENCY_KEY_DEPENDENT_OPTIONS = [
  'experimental_idempotencyKeyTTL',
  'experimental_idempotencyKeyReusePolicy',
  'experimental_idempotencyKeyConflictPolicy',
] as const;

type IdempotencyStartOptions = Pick<
  StartOptionsBase,
  | 'experimental_idempotencyKey'
  | (typeof IDEMPOTENCY_KEY_DEPENDENT_OPTIONS)[number]
  | 'specVersion'
>;

/**
 * The error `start()` throws when it refuses a keyed start: invalid key
 * options, a World without `capabilities.runIdempotencyKeys`, a legacy spec
 * version, or a refusal that names no valid holder run.
 *
 * Each is deterministic, so a retry fails the same way. `fatal` tells the
 * step executor so when `start()` runs inside a step, the same way
 * `dynamicStartRefusal` does for dynamic starts; the error is
 * otherwise a plain `WorkflowRuntimeError`.
 */
export function keyedStartRefusal(
  message: string,
  options?: ErrorOptions
): WorkflowRuntimeError & { fatal: true } {
  return Object.assign(new WorkflowRuntimeError(message, options), {
    fatal: true as const,
  });
}

function assertIdempotencyKey(key: unknown): asserts key is string {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    throw keyedStartRefusal(
      `start({ experimental_idempotencyKey }) must be a string of 1 to ${IDEMPOTENCY_KEY_MAX_LENGTH} characters; received ${
        typeof key === 'string'
          ? `a string of ${key.length} characters`
          : typeof key
      }.`
    );
  }
  // A lone surrogate has no UTF-8 encoding, so no backend can store the key.
  if (!isWellFormedString(key)) {
    throw keyedStartRefusal(
      'start({ experimental_idempotencyKey }) must be well-formed UTF-16: it contains a lone surrogate.'
    );
  }
}

/** Whole milliseconds for a TTL option, or `undefined` when unparseable. */
function idempotencyKeyTtlToMs(ttl: unknown): number | undefined {
  if (typeof ttl === 'string') {
    const value = ms(ttl as StringValue);
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.round(value)
      : undefined;
  }
  return typeof ttl === 'number' && Number.isInteger(ttl) ? ttl : undefined;
}

function resolveIdempotencyKeyTtlMs(ttl: unknown): number {
  if (ttl === undefined) return IDEMPOTENCY_KEY_TTL_DEFAULT_MS;
  const ttlMs = idempotencyKeyTtlToMs(ttl);
  if (
    ttlMs === undefined ||
    ttlMs < IDEMPOTENCY_KEY_TTL_MIN_MS ||
    ttlMs > IDEMPOTENCY_KEY_TTL_MAX_MS
  ) {
    throw keyedStartRefusal(
      `start({ experimental_idempotencyKeyTTL }) must be a duration between '1s' and '30d' (a duration string or whole milliseconds); received ${JSON.stringify(
        ttl
      )}.`
    );
  }
  return ttlMs;
}

/** `value` if it is one of `schema`'s options (or `fallback` when unset). */
function resolveIdempotencyPolicy<T extends string>(
  option: string,
  value: unknown,
  schema: {
    options: readonly T[];
    safeParse(value: unknown): { success: boolean };
  },
  fallback: T
): T {
  if (value === undefined) return fallback;
  if (!schema.safeParse(value).success) {
    throw keyedStartRefusal(
      `start({ ${option} }) must be one of ${schema.options
        .map((name) => `'${name}'`)
        .join(', ')}; received ${JSON.stringify(value)}.`
    );
  }
  return value as T;
}

/**
 * Validate the idempotency options of a `start()` call and resolve their
 * defaults. Pure: runs before any I/O, so an invalid combination never
 * reaches the World. Returns `undefined` for an unkeyed start.
 *
 * Exported for tests.
 */
export function resolveIdempotencyOptions(
  opts: IdempotencyStartOptions
): ResolvedIdempotencyOptions | undefined {
  const key: unknown = opts.experimental_idempotencyKey;
  if (key === undefined) {
    const orphans = IDEMPOTENCY_KEY_DEPENDENT_OPTIONS.filter(
      (name) => opts[name] !== undefined
    );
    if (orphans.length > 0) {
      throw keyedStartRefusal(
        `start({ ${orphans.join(', ')} }) requires experimental_idempotencyKey.`
      );
    }
    return undefined;
  }
  assertIdempotencyKey(key);
  // The legacy (spec version 1) write path drops the key, so a keyed start
  // there would silently create duplicates. An explicit version is refused
  // here; one resolved from the target deployment is checked once known.
  if (opts.specVersion !== undefined && isLegacySpecVersion(opts.specVersion)) {
    throw legacyKeyedStartRefusal(opts.specVersion);
  }
  return {
    key,
    ttlMs: resolveIdempotencyKeyTtlMs(opts.experimental_idempotencyKeyTTL),
    reusePolicy: resolveIdempotencyPolicy(
      'experimental_idempotencyKeyReusePolicy',
      opts.experimental_idempotencyKeyReusePolicy,
      IdempotencyKeyReusePolicySchema,
      'REJECT_DUPLICATE'
    ),
    conflictPolicy: resolveIdempotencyPolicy(
      'experimental_idempotencyKeyConflictPolicy',
      opts.experimental_idempotencyKeyConflictPolicy,
      IdempotencyKeyConflictPolicySchema,
      'USE_EXISTING'
    ),
  };
}

export function legacyKeyedStartRefusal(
  specVersion: number
): WorkflowRuntimeError & { fatal: true } {
  return keyedStartRefusal(
    `start({ experimental_idempotencyKey }) requires spec version ${SPEC_VERSION_SUPPORTS_EVENT_SOURCING} or later; this run would be stamped with spec version ${specVersion}, whose writes do not carry the key, so no run was created.`
  );
}

/**
 * The queue idempotency key for a run's initial message. Shared by a keyed
 * start's own publish and by the re-publish for a pending holder it adopts,
 * so the two collapse onto one delivery where the queue deduplicates.
 */
export function startMessageIdempotencyKey(runId: string): string {
  return `start-${runId}`;
}

/**
 * Handle a refusal naming the run that holds the key, before the conflict
 * policy is applied (so for `FAIL` too), and return the holder's run id.
 *
 * - The holder must be a real run id. A backend that refused without naming
 *   one leaves nothing to return or adopt, so the start is refused outright
 *   rather than handing back a handle to a run that does not exist.
 * - A `pending` holder may be a run whose own start never published (the
 *   publish failed, or its response was lost before the caller retried).
 *   Its initial message is published again, with the same queue key its own
 *   start used, so the key never stays locked by a run nothing will execute.
 *   A failure is thrown, so the caller retries.
 * - When the refusal does not report the holder's status, it is read.
 */
export async function adoptKeyHolder(
  world: World,
  refusal: WorkflowRunAlreadyStartedError,
  traceCarrier: Record<string, string>
): Promise<string> {
  if (!workflowRunIdSchema.safeParse(refusal.runId).success) {
    throw keyedStartRefusal(
      `The Workflow backend refused this keyed start but did not name a valid run holding the key (received ${JSON.stringify(
        String(refusal.runId).slice(0, 64)
      )}), so there is no run to return. No run was created.`,
      { cause: refusal }
    );
  }
  let holder: Awaited<ReturnType<World['runs']['get']>> | undefined;
  let runStatus = refusal.runStatus;
  if (runStatus === undefined) {
    holder = await world.runs.get(refusal.runId, { resolveData: 'none' });
    runStatus = holder.status;
    (refusal as { runStatus?: string }).runStatus = runStatus;
  }
  if (runStatus === 'pending') {
    holder ??= await world.runs.get(refusal.runId, { resolveData: 'none' });
    await world.queue(
      getWorkflowQueueName(
        holder.workflowName,
        getRunQueueNamespace(holder.executionContext)
      ),
      { runId: holder.runId, traceCarrier } satisfies WorkflowInvokePayload,
      {
        deploymentId: holder.deploymentId,
        specVersion: holder.specVersion,
        idempotencyKey: startMessageIdempotencyKey(holder.runId),
      }
    );
  }
  return refusal.runId;
}

/**
 * A backend with run idempotency keys switched off refuses every keyed
 * start the same way, so its error is made `fatal` (a `start()` step is not
 * retried on it). Other errors pass through unchanged.
 */
export function markKeysDisabledFatal(err: unknown): unknown {
  if (
    WorkflowWorldError.is(err) &&
    err.code === IDEMPOTENCY_KEYS_DISABLED_CODE &&
    !FatalError.is(err)
  ) {
    try {
      Object.defineProperty(err, 'fatal', {
        value: true,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch {
      // A frozen error keeps its own shape.
    }
  }
  return err;
}

/**
 * Holds back a keyed start's argument streams until the run they belong to
 * is known to exist.
 *
 * Without it, each `ReadableStream` argument would start piping into a
 * server stream of the candidate run as soon as it is serialized, so a start
 * refused because another run holds the key would still drain a one-shot
 * source (a webhook's `request.body`, say) into a run that never exists,
 * although a refused start's arguments are ignored. `open()` once the run is
 * created, or found already created by this very start (a self-conflict);
 * `close()` on a refusal or any other failure, which leaves every argument
 * stream untouched: never read, locked, or cancelled.
 *
 * The gate resolves, never rejects, so nothing waiting on it can surface as
 * an unhandled rejection. Settling it twice is a no-op, so `close()` after
 * `open()` changes nothing.
 */
export function createArgumentStreamGate(): {
  gate: Promise<boolean>;
  open(): void;
  close(): void;
} {
  let settle!: (open: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return {
    gate,
    open: () => settle(true),
    close: () => settle(false),
  };
}
