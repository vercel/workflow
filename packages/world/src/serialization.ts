import { z } from 'zod';

/**
 * Binary serialized data using devalue format.
 * This is the output of `TextEncoder.encode(devalue.stringify(...))`.
 *
 * The workflow core runtime handles serialization/deserialization,
 * and World implementations store and transport this opaque binary payload.
 */
export type SerializedData = Uint8Array | unknown;

/**
 * Zod schema for validating SerializedData (Uint8Array).
 * Used for specVersion >= 2.
 */
export const BinarySerializedDataSchema: z.ZodType<SerializedData> =
  z.instanceof(Uint8Array) as z.ZodType<SerializedData>;

/**
 * Legacy schema for serialized data (specVersion 1).
 * Legacy data was stored as JSON, so it can be any value.
 */
export const LegacySerializedDataSchemaV1: z.ZodType<unknown> = z.any();

/**
 * Union schema that accepts both v2+ (Uint8Array) and legacy (any) serialized data.
 * Use this for validation when data may come from either specVersion.
 */
export const SerializedDataSchema = z.union([
  BinarySerializedDataSchema,
  LegacySerializedDataSchemaV1,
]);
