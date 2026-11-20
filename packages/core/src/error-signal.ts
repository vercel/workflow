import { FatalError } from '@workflow/errors';

/**
 * The plaintext classification of a thrown value that `run_failed`,
 * `step_failed` and `step_retrying` carry beside the serialized (and, when the
 * run is encrypted, encrypted) error: the error's class name and its HTTP
 * status. Lets a World and its operators tell what kind of error failed a run
 * or step (a third-party API rejection, a timeout, an SDK error) without
 * decrypting the payload.
 *
 * Never the message, the stack, or any other property: those can hold user
 * data and stay inside the serialized error.
 */
export interface ErrorSignalFields {
  /** The error's class name (`Error#name`), when it is an identifier. */
  errorName?: string;
  /** The error's HTTP status (`statusCode`, else `status`), 100-599. */
  errorStatus?: number;
}

/** Longest `errorName` recorded, in characters. */
export const MAX_ERROR_NAME_LENGTH = 128;

// An identifier, dots allowed for namespaced names (`Stripe.errors.X`). Free
// text (a sentence, a message, a path) is not a class name and is dropped, so
// a name that a library builds from its message never reaches plaintext.
const ERROR_NAME_PATTERN = new RegExp(
  `^[A-Za-z_$][A-Za-z0-9_$.]{0,${MAX_ERROR_NAME_LENGTH - 1}}$`
);

/** How many `FatalError` wrappers are unwrapped looking for the original. */
const MAX_UNWRAP_DEPTH = 4;

/**
 * The {@link ErrorSignalFields} of a thrown value, for spreading into a
 * failure event's `eventData`. Empty for a value that is not an object or has
 * no recognizable name or status.
 *
 * A `FatalError` with a `cause` reports its cause: that is how the SDK wraps a
 * step's last error when it runs out of retries (and how a user marks an
 * error as not retryable), so the cause is the error that actually failed.
 *
 * Never throws: a getter that throws, or a proxy, yields no field rather than
 * failing the event write it was meant to annotate.
 */
export function errorSignalFields(value: unknown): ErrorSignalFields {
  try {
    const error = unwrapFatalCause(value);
    if (typeof error !== 'object' || error === null) return {};
    const errorName = readErrorName(error);
    const errorStatus = readErrorStatus(error);
    return {
      ...(errorName !== undefined && { errorName }),
      ...(errorStatus !== undefined && { errorStatus }),
    };
  } catch {
    return {};
  }
}

function unwrapFatalCause(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    if (!FatalError.is(current)) break;
    const cause = (current as { cause?: unknown }).cause;
    if (typeof cause !== 'object' || cause === null) break;
    current = cause;
  }
  return current;
}

function readErrorName(error: object): string | undefined {
  const name = (error as { name?: unknown }).name;
  if (typeof name !== 'string') return undefined;
  // `class StripeError extends Error {}` that never sets `name` inherits
  // `'Error'`; its constructor still says which class it is. Only for a real
  // error (in any realm): a plain object's constructor is `Object`.
  if (
    name === 'Error' &&
    Object.prototype.toString.call(error) === '[object Error]'
  ) {
    const constructorName = (error as { constructor?: { name?: unknown } })
      .constructor?.name;
    if (
      typeof constructorName === 'string' &&
      constructorName !== 'Error' &&
      ERROR_NAME_PATTERN.test(constructorName)
    ) {
      return constructorName;
    }
  }
  const trimmed = name.trim();
  return ERROR_NAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

function readErrorStatus(error: object): number | undefined {
  const { statusCode, status } = error as {
    statusCode?: unknown;
    status?: unknown;
  };
  if (isHttpStatus(statusCode)) return statusCode;
  if (isHttpStatus(status)) return status;
  return undefined;
}

function isHttpStatus(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}
