import { FatalError } from '@workflow/errors';
import type { EventOfType } from '@workflow/world';
import {
  type AttributeChange,
  AttributeValidationError,
  validateAttributeChanges,
  validateAttributeEventDataSize,
} from '@workflow/world/attributes-validation';

export function normalizeAttributeChanges(
  attrs: Record<string, string | undefined>,
  options: { allowReservedAttributes?: boolean } = {},
  writer?: EventOfType<'attr_set'>['eventData']['writer']
): AttributeChange[] {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    throw new FatalError(
      `setAttributes requires a plain object, got ${
        attrs === null ? 'null' : Array.isArray(attrs) ? 'array' : typeof attrs
      }`
    );
  }

  const changes: AttributeChange[] = Object.entries(attrs).map(
    ([key, value]) => ({
      key,
      value: value === undefined ? null : value,
    })
  );
  if (changes.length === 0) return changes;

  const allowReservedAttributes = options.allowReservedAttributes === true;
  try {
    validateAttributeChanges(changes, { allowReservedAttributes });
    // Initial run attributes use this normalizer too, but are not attr_set.
    if (writer) {
      validateAttributeEventDataSize({
        changes,
        writer,
        ...(allowReservedAttributes ? { allowReservedAttributes: true } : {}),
      });
    }
  } catch (err) {
    if (err instanceof AttributeValidationError) {
      throw new FatalError(err.message);
    }
    throw err;
  }

  return changes;
}
