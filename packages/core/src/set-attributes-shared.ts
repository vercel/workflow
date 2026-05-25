import { FatalError } from '@workflow/errors';
import type { AttributeChange } from '@workflow/world';
import {
  AttributeValidationError,
  validateAttributeChanges,
} from '@workflow/world';

/**
 * Validate and normalize a `setAttributes(record)` call. Returns the
 * canonical `AttributeChange[]` shape (with `undefined → null`) or
 * throws `FatalError` on a violation. Returns `null` if the input is
 * empty (callers must short-circuit without dispatching a step).
 *
 * Note: this module is imported in VM context, so can't contain a `'use step'` directive,
 * side-effects, or Node-only modules.
 *
 * @internal
 */
export function normalizeSetAttributesInput(
  attrs: Record<string, string | undefined>
): AttributeChange[] | null {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    throw new FatalError(
      `setAttributes requires a plain object, got ${attrs === null ? 'null' : Array.isArray(attrs) ? 'array' : typeof attrs}`
    );
  }
  const changes: AttributeChange[] = Object.entries(attrs).map(
    ([key, value]) => ({
      key,
      value: value === undefined ? null : value,
    })
  );
  if (changes.length === 0) return null;
  try {
    validateAttributeChanges(changes);
  } catch (err) {
    if (err instanceof AttributeValidationError) {
      throw new FatalError(err.message);
    }
    throw err;
  }
  return changes;
}
