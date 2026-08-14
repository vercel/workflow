import { z } from 'zod';

import type { AttributeChange } from './attributes-validation.js';

export * from './attributes-validation.js';

/** Runtime schema for a single run-attribute change. */
export const AttributeChangeSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.null()]),
}) satisfies z.ZodType<AttributeChange>;

export const AttributeChangesSchema = z.array(AttributeChangeSchema);

/** The post-merge attribute snapshot returned by a World. */
export interface ExperimentalSetAttributesResult {
  attributes: Record<string, string>;
}
