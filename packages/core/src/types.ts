import { types } from 'node:util';
import { FatalError } from '@workflow/errors';
import { envNumber } from '@workflow/world/env-config';

export function getErrorName(v: unknown): string {
  if (types.isNativeError(v)) {
    return v.name;
  }
  return 'Error';
}

export function getErrorMessage(v: unknown): string {
  return types.isNativeError(v) ? v.message : String(v);
}

export function getErrorStack(v: unknown): string {
  if (types.isNativeError(v)) {
    const stack = readProperty(v, 'stack');
    return typeof stack === 'string' ? stack : '';
  }
  return '';
}

/** Upper bound on the links {@link formatErrorCauseChain} renders. */
const MAX_CAUSE_LINKS = 4;

/** One `Name: message (CODE)` line for a link in a cause chain. */
function describeErrorLink(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return String(value);
  }
  const { name, message, code } = value as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
  };
  const label = typeof name === 'string' && name ? name : 'Error';
  const text =
    typeof message === 'string' && message ? `${label}: ${message}` : label;
  return typeof code === 'string' && code && !text.includes(code)
    ? `${text} (${code})`
    : text;
}

/**
 * Summarize the `cause` chain hanging off a thrown value, one link per line,
 * outermost first. The value itself is skipped: whatever logs this already
 * states it, in the message or in the stack header.
 *
 * `util.inspect` renders `[cause]` when Node prints an error, but the
 * structured logs read `name` / `message` / `stack` and drop everything else
 * — exactly the wrong half for errors that arrive pre-wrapped.
 * `TypeError: fetch failed` is the canonical one: undici's wrapper says
 * nothing on its own and its stack is all `node:internal/` frames, so the DNS,
 * socket or TLS failure that actually happened is only readable one or two
 * `cause` hops down. Same for the world layer's own wrapping, where the
 * request that failed is on the wrapper and the reason it failed is on the
 * cause.
 *
 * `AggregateError` also gets its `errors` summarized, because a
 * happy-eyeballs connect reports every attempt there and leaves the
 * `AggregateError` itself blank.
 *
 * Returns `''` when there is no cause, so callers can drop the field.
 */
export function formatErrorCauseChain(value: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();

  try {
    for (
      let current = causeOf(value);
      current != null && lines.length <= MAX_CAUSE_LINKS;
      current = causeOf(current)
    ) {
      if (typeof current !== 'object') {
        lines.push(String(current));
        break;
      }
      // A cause chain can loop (`err.cause = err`) or repeat a shared error.
      if (seen.has(current)) break;
      seen.add(current);
      lines.push(describeErrorLink(current), ...aggregatedLinks(current));
    }
  } catch {
    // Causes can contain getters or proxies that throw. Logging must not
    // replace the original error or prevent the run_failed event from being written.
    lines.push('[unavailable cause]');
  }

  return lines.length > MAX_CAUSE_LINKS
    ? [...lines.slice(0, MAX_CAUSE_LINKS), '…'].join('\n')
    : lines.join('\n');
}

function causeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? (value as { cause?: unknown }).cause
    : undefined;
}

/** The attempts an `AggregateError` collected, if this link is one. */
function aggregatedLinks(value: object): string[] {
  const errors = (value as { errors?: unknown }).errors;
  return Array.isArray(errors)
    ? errors.slice(0, MAX_CAUSE_LINKS).map(describeErrorLink)
    : [];
}

export function isAbortError(
  value: unknown
): value is { name: 'AbortError'; message: string; stack?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === 'AbortError' &&
    'message' in value &&
    typeof value.message === 'string' &&
    (!('stack' in value) ||
      value.stack === undefined ||
      typeof value.stack === 'string')
  );
}

export function promoteAbortErrorToFatal(value: unknown): unknown {
  if (!isAbortError(value) || FatalError.is(value)) {
    return value;
  }

  const fatalError = new FatalError(`Aborted: ${value.message}`);
  if (value.stack) {
    fatalError.stack = value.stack;
  }
  return fatalError;
}

export interface NormalizedUnknownError {
  name: string;
  message: string;
  stack: string;
  unwrapped?: unknown;
}

export const THROWN_THENABLE_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const THENABLE_MAX_DEPTH = 8;

export function getThrownThenableTimeoutMs(): number {
  return envNumber(
    'WORKFLOW_THROWN_THENABLE_TIMEOUT_MS',
    THROWN_THENABLE_TIMEOUT_MS,
    { integer: true, min: 1, max: MAX_TIMER_MS }
  );
}

type Then = (
  onFulfilled: (value: unknown) => void,
  onRejected: (reason: unknown) => void
) => unknown;

function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function getThen(value: unknown): Then | undefined {
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function'
  ) {
    return undefined;
  }
  const then = readProperty(value as object, 'then');
  return typeof then === 'function' ? (then as Then) : undefined;
}

// settlements are boxed so a thenable never reaches native promise adoption
function settle(value: unknown, then: Then): Promise<{ value: unknown }> {
  return new Promise((resolve) => {
    try {
      then.call(
        value,
        (fulfilled) => resolve({ value: fulfilled }),
        (rejected) => resolve({ value: rejected })
      );
    } catch (error) {
      resolve({ value: error });
    }
  });
}

function describeValue(v: unknown): string {
  if (typeof v === 'function') {
    const name = readProperty(v, 'name');
    return typeof name === 'string' && name ? `function ${name}` : 'function';
  }
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    try {
      return String(v);
    } catch {
      return typeof v;
    }
  }
}

function normalizeSyncError(v: unknown): NormalizedUnknownError {
  if (types.isNativeError(v)) {
    const name = readProperty(v, 'name');
    const message = readProperty(v, 'message');
    return {
      name: typeof name === 'string' ? name : 'Error',
      message: typeof message === 'string' ? message : describeValue(message),
      stack: getErrorStack(v),
    };
  }

  return {
    name: 'Error',
    message: typeof v === 'string' ? v : describeValue(v),
    stack: '',
  };
}

function readErrors(value: object): unknown[] {
  try {
    const errors = readProperty(value, 'errors');
    return Array.isArray(errors) ? [...errors] : [];
  } catch {
    return [];
  }
}

function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    ['string', 'number', 'boolean', 'undefined'].includes(typeof value)
  );
}

export function toPlainError(
  value: unknown,
  normalized: NormalizedUnknownError,
  path: unknown[] = [],
  copies = new Map<unknown, Error>()
): Error {
  const expand =
    typeof value === 'object' &&
    value !== null &&
    path.length < MAX_CAUSE_LINKS &&
    !path.includes(value);
  const name =
    !expand && normalized.name === 'AggregateError' ? 'Error' : normalized.name;
  const error = Object.assign(new Error(normalized.message), {
    name,
    stack: normalized.stack,
  });
  if (!expand) return error;

  path.push(value);
  const reduce = (link: unknown): unknown =>
    isPrimitive(link)
      ? link
      : (copies.get(link) ??
        toPlainError(link, normalizeSyncError(link), path, copies));
  const cause = readProperty(value, 'cause');
  if (cause !== undefined) Object.assign(error, { cause: reduce(cause) });
  // the AggregateError reviver throws when errors is missing
  if (name === 'AggregateError') {
    Object.assign(error, { errors: readErrors(value).map(reduce) });
  }
  path.pop();
  copies.set(value, error);
  return error;
}

function promiseRejection(message: string): NormalizedUnknownError {
  const normalized = {
    name: 'Error',
    message: `Promise rejection: ${message}`,
    stack: '',
  };
  return { ...normalized, unwrapped: toPlainError(undefined, normalized) };
}

/**
 * Normalizes unknown thrown values into a stable error shape.
 * This handles Promise/thenable throw values so logs/events never end up
 * with unhelpful "[object Promise]" messages.
 */
export async function normalizeUnknownError(
  value: unknown
): Promise<NormalizedUnknownError> {
  let then = getThen(value);
  if (!then) return normalizeSyncError(value);

  const timeoutMs = getThrownThenableTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });

  try {
    let current = value;
    for (let depth = 0; then && depth < THENABLE_MAX_DEPTH; depth++) {
      const settled = await Promise.race([settle(current, then), deadline]);
      if (!settled) {
        return promiseRejection(
          `thrown thenable did not settle within ${timeoutMs}ms`
        );
      }
      current = settled.value;
      then = getThen(current);
    }
    if (then) {
      return promiseRejection(
        `thrown thenable kept resolving to another thenable after ${THENABLE_MAX_DEPTH} steps`
      );
    }
    const normalized = normalizeSyncError(current);
    return {
      ...normalized,
      message: `Promise rejection: ${normalized.message}`,
      unwrapped: current,
    };
  } finally {
    clearTimeout(timer);
  }
}
