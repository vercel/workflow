import * as z from 'zod';

import {
  ATTRIBUTE_KEY_MAX_LENGTH,
  ATTRIBUTE_VALUE_MAX_BYTES,
  type AttributeChange,
  AttributeValidationError,
  validateAttributeBatchConstraints,
} from './attributes-validation.js';

export * from './attributes-validation.js';

const textEncoder = new TextEncoder();

export const AttributeKeySchema = z
  .string()
  .min(1, { error: 'Attribute key must not be empty' })
  .max(ATTRIBUTE_KEY_MAX_LENGTH, {
    error: `Attribute key exceeds limit ${ATTRIBUTE_KEY_MAX_LENGTH}`,
  });

export const AttributeValueSchema = z
  .string()
  .refine(
    (value) => textEncoder.encode(value).length <= ATTRIBUTE_VALUE_MAX_BYTES,
    {
      error: `Attribute value exceeds limit ${ATTRIBUTE_VALUE_MAX_BYTES} UTF-8 bytes`,
    }
  )
  .nullable();

/** Runtime schema for a single run-attribute change. */
export const AttributeChangeSchema = z.object({
  key: AttributeKeySchema,
  value: AttributeValueSchema,
}) satisfies z.ZodType<AttributeChange>;

export const AttributeChangesSchema = z
  .array(AttributeChangeSchema)
  .superRefine((changes, context) => {
    try {
      // Reserved keys are contextual: attr_set events may carry them when the
      // sibling allowReservedAttributes flag is set. Callers that prohibit the
      // reserved namespace enforce that through validateAttributeChanges.
      validateAttributeBatchConstraints(changes);
    } catch (error) {
      if (!(error instanceof AttributeValidationError)) throw error;
      context.addIssue({
        code: 'custom',
        message: error.message,
        input: changes,
      });
    }
  });

/** The post-merge attribute snapshot returned by a World. */
export interface ExperimentalSetAttributesResult {
  attributes: Record<string, string>;
}
