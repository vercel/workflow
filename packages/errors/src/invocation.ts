import type {
  InvocationOutcome,
  SerializedWorkflowError,
} from '@workflow/world';
import * as errors from './index.js';

/** Copy diagnostics without getters, prototype mutation, or cyclic wire values. */
function diagnostic(
  value: unknown,
  seen = new Set<object>(),
  depth = 0
): unknown {
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'function' || typeof value === 'symbol'
      ? String(value)
      : value;
  }
  if (depth >= 16) return '[Maximum diagnostic depth]';
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Date || value instanceof Uint8Array) return value;
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => diagnostic(item, seen, depth + 1));
    return Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(value))
        .filter(([key, descriptor]) => !reserved(key) && 'value' in descriptor)
        .map(([key, descriptor]) => [
          key,
          diagnostic(descriptor.value, seen, depth + 1),
        ])
    );
  } finally {
    seen.delete(value);
  }
}

function reserved(key: string) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

export function serializeWorkflowError(
  value: unknown,
  seen = new Set<object>()
): SerializedWorkflowError {
  if (typeof value !== 'object' || value === null) {
    return { name: 'Error', message: String(value), fields: {} };
  }
  if (seen.has(value) || seen.size >= 16) {
    return {
      name: 'Error',
      message: '[Circular or nested error cause]',
      fields: {},
    };
  }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = Object.fromEntries(
    Object.entries(descriptors)
      .filter(
        ([key, descriptor]) =>
          !reserved(key) &&
          !['name', 'message', 'stack', 'cause'].includes(key) &&
          'value' in descriptor
      )
      .map(([key, descriptor]) => [key, diagnostic(descriptor.value)])
  );
  const error = value as Error;
  const cause =
    descriptors.cause && 'value' in descriptors.cause
      ? descriptors.cause.value
      : undefined;
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message:
      typeof error.message === 'string'
        ? error.message
        : 'Invocation handler threw a non-Error value',
    ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    fields,
    ...(cause !== undefined
      ? Object.prototype.toString.call(cause) === '[object Error]'
        ? { cause: serializeWorkflowError(cause, seen) }
        : { causeValue: diagnostic(cause) }
      : {}),
  };
}

/** Restore local class identity without re-running constructors/formatting messages. */
export function deserializeWorkflowError(
  value: SerializedWorkflowError
): Error {
  const error = new Error(value.message);
  const ctor = Object.hasOwn(errors, value.name)
    ? errors[value.name as keyof typeof errors]
    : undefined;
  if (typeof ctor === 'function' && ctor.prototype instanceof Error) {
    Object.setPrototypeOf(error, ctor.prototype);
  }
  Object.defineProperty(error, 'name', {
    value: value.name,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  if (value.stack !== undefined) error.stack = value.stack;
  for (const [key, field] of Object.entries(value.fields)) {
    if (reserved(key) || ['name', 'message', 'stack', 'cause'].includes(key))
      continue;
    Object.defineProperty(error, key, {
      value: field,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (value.cause || Object.hasOwn(value, 'causeValue'))
    Object.defineProperty(error, 'cause', {
      value: value.cause
        ? deserializeWorkflowError(value.cause)
        : value.causeValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return error;
}

/** Protocol statuses that signal a transient, retry-worthy failure. */
const RETRYABLE_STATUS = new Set([408, 425, 429]);

/**
 * A terminal invocation error is a recognized Workflow error describing a
 * deterministic condition (bad input, hook/run gone, data expired, identity
 * conflict). Such errors recur on every redelivery, so the executor should
 * store them as the invocation's permanent outcome instead of retrying.
 *
 * Everything else is NOT terminal and must be re-thrown so the delivery layer
 * retries (matching the pre-outcome throw-to-retry contract):
 *   - unknown/infra failures — DB blips, connection resets, thrown non-Errors,
 *     or any error class the errors package does not own; and
 *   - transient Workflow errors — a 5xx / 408 / 425 / 429 status, or any error
 *     carrying a `retryAfter` (throttle / too-early / retryable).
 *
 * Capturing a transient failure as a permanent outcome would ack the delivery
 * and leave a hook resume (whose `hook_received` write never committed)
 * unretried, suspending the workflow forever.
 */
export function isTerminalInvocationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  // Only classes the errors package owns describe known, deterministic
  // conditions; anything else is an unexpected/infra failure that must retry.
  if (typeof name !== 'string' || !Object.hasOwn(errors, name)) return false;
  const ctor = errors[name as keyof typeof errors];
  if (typeof ctor !== 'function' || !(ctor.prototype instanceof Error))
    return false;
  const { status, retryAfter } = error as {
    status?: unknown;
    retryAfter?: unknown;
  };
  if (retryAfter !== undefined) return false;
  if (
    typeof status === 'number' &&
    (status >= 500 || RETRYABLE_STATUS.has(status))
  )
    return false;
  return true;
}

/**
 * Run `handler` and capture its result as an {@link InvocationOutcome}. Thrown
 * errors are captured only when `shouldCapture` returns `true`; otherwise they
 * are re-thrown so the caller's delivery layer can retry. The default captures
 * every error, so generic request/response transports keep prior behavior.
 */
export async function captureInvocationOutcome(
  handler: () => Promise<unknown>,
  shouldCapture: (error: unknown) => boolean = () => true
): Promise<InvocationOutcome> {
  try {
    return { ok: true, value: await handler() };
  } catch (error) {
    if (!shouldCapture(error)) throw error;
    return { ok: false, error: serializeWorkflowError(error) };
  }
}

function isWireError(
  value: unknown,
  depth = 0
): value is SerializedWorkflowError {
  if (depth > 16 || typeof value !== 'object' || value === null) return false;
  const error = value as SerializedWorkflowError;
  return (
    typeof error.name === 'string' &&
    typeof error.message === 'string' &&
    (error.stack === undefined || typeof error.stack === 'string') &&
    typeof error.fields === 'object' &&
    error.fields !== null &&
    !Array.isArray(error.fields) &&
    (error.cause === undefined || isWireError(error.cause, depth + 1))
  );
}

export function unwrapInvocationOutcome(outcome: unknown): unknown {
  if (typeof outcome === 'object' && outcome !== null && 'ok' in outcome) {
    if (outcome.ok === true && 'value' in outcome) return outcome.value;
    if (
      outcome.ok === false &&
      'error' in outcome &&
      isWireError(outcome.error)
    ) {
      throw deserializeWorkflowError(outcome.error);
    }
  }
  throw new errors.WorkflowWorldError(
    'Invalid invocation outcome; outcome is unknown',
    { status: 502 }
  );
}
