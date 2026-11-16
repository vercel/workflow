import { WorkflowWorldError } from '@workflow/errors';

function truncateForError(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value);
  const MAX = 48;
  return s.length > MAX ? `${s.slice(0, MAX)}…` : s;
}

/**
 * Thrown when a caller-supplied entity ID is empty or contains `.`, `/`, `\`
 * or a NUL byte. IDs no longer name files, but the rule is part of what this
 * World has always accepted, so it stays: the same IDs are valid on every
 * release.
 */
export class UnsafeEntityIdError extends WorkflowWorldError {
  constructor(kind: string, value: string) {
    super(
      `Unsafe ${kind} "${truncateForError(value)}": must not be empty, contain ".", "/", "\\", or null bytes`
    );
    this.name = 'UnsafeEntityIdError';
  }

  static is(value: unknown): value is UnsafeEntityIdError {
    return value instanceof Error && value.name === 'UnsafeEntityIdError';
  }
}

export function assertSafeEntityId(kind: string, value: string): void {
  if (
    value.length === 0 ||
    value.includes('.') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new UnsafeEntityIdError(kind, value);
  }
}
