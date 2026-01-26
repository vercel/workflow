import { z } from 'zod';

/**
 * Binary serialized data using devalue format.
 * This is the output of `TextEncoder.encode(devalue.stringify(...))`.
 *
 * The workflow core runtime handles serialization/deserialization,
 * and World implementations store and transport this opaque binary payload.
 */
export type SerializedData = Uint8Array;

/**
 * Zod schema for validating SerializedData (Uint8Array).
 */
export const SerializedDataSchema: z.ZodType<SerializedData> = z.instanceof(
  Uint8Array
) as z.ZodType<SerializedData>;
