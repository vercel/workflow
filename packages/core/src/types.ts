import { types } from 'node:util';

export function getErrorName(v: unknown): string {
  if (types.isNativeError(v)) {
    return v.name;
  }
  return 'Error';
}

export function getErrorStack(v: unknown): string {
  if (types.isNativeError(v)) {
    return v.stack ?? '';
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

export interface NormalizedUnknownError {
  name: string;
  message: string;
  stack: string;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function normalizeSyncError(v: unknown): NormalizedUnknownError {
  if (types.isNativeError(v)) {
    return {
      name: v.name,
      message: v.message,
      stack: v.stack ?? '',
    };
  }

  if (typeof v === 'string') {
    return {
      name: 'Error',
      message: v,
      stack: '',
    };
  }

  try {
    return {
      name: 'Error',
      message: JSON.stringify(v),
      stack: '',
    };
  } catch {
    return {
      name: 'Error',
      message: String(v),
      stack: '',
    };
  }
}

/**
 * Normalizes unknown thrown values into a stable error shape.
 * This handles Promise/thenable throw values so logs/events never end up
 * with unhelpful "[object Promise]" messages.
 */
export async function normalizeUnknownError(
  value: unknown
): Promise<NormalizedUnknownError> {
  if (isThenable(value)) {
    try {
      const resolved = await value;
      const normalized = await normalizeUnknownError(resolved);
      return {
        ...normalized,
        message: `Promise rejection: ${normalized.message}`,
      };
    } catch (rejection) {
      const normalized = await normalizeUnknownError(rejection);
      return {
        ...normalized,
        message: `Promise rejection: ${normalized.message}`,
      };
    }
  }

  return normalizeSyncError(value);
}
