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
