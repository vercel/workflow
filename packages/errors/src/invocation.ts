import type {
  InvocationOutcome,
  SerializedWorkflowError,
} from '@workflow/world';
import * as errors from './index.js';

/** Copy diagnostic values for transport, omitting object accessors and bounding cycles and nesting. */
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

/** Restore a known Workflow error's prototype and fields without calling its constructor. */
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

/** HTTP statuses below 500 that indicate the request can be retried. */
const RETRYABLE_STATUS = new Set([408, 425, 429]);

/**
 * Return whether a recognized Workflow error should be stored as the request's
 * terminal outcome. Missing hooks, expired runs, and input-identity conflicts
 * are examples of terminal failures.
 *
 * Return false for unrecognized errors, retryAfter-bearing errors, status codes
 * of 500 or higher, and statuses 408, 425, and 429. The delivery layer must retry
 * these failures. Storing them as terminal outcomes would prevent those retries.
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
 * Run handler and encode its return value or error as an InvocationOutcome.
 * By default, capture every thrown error. When shouldCapture returns false,
 * rethrow the error so the delivery layer can retry it.
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
