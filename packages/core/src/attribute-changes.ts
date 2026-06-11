import { FatalError } from '@workflow/errors';
import {
  type AttributeChange,
  AttributeValidationError,
  validateAttributeChanges,
} from '@workflow/world';

interface AttributeChangeOptions {
  allowReservedAttributes?: boolean;
}

export function normalizeAttributeChanges(
  attrs: Record<string, string | undefined>,
  options: AttributeChangeOptions = {}
): AttributeChange[] {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    throw new FatalError(
      `experimental_setAttributes requires a plain object, got ${
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
  } catch (err) {
    if (err instanceof AttributeValidationError) {
      throw new FatalError(err.message);
    }
    throw err;
  }

  return changes;
}
