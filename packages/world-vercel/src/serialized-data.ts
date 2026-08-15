import * as nodeZlib from 'node:zlib';
import { WorkflowWorldError } from '@workflow/errors';
import {
  peekSerializationFormat,
  SerializationFormat,
} from '@workflow/world/serialization-format.js';

function decompress(
  format: typeof SerializationFormat.GZIP | typeof SerializationFormat.ZSTD,
  payload: Uint8Array
): Uint8Array {
  const decompress =
    format === SerializationFormat.ZSTD
      ? nodeZlib.zstdDecompressSync
      : nodeZlib.gunzipSync;

  if (!decompress) {
    throw new WorkflowWorldError(
      `Received ${format}-compressed workflow data, but this Node.js runtime does not support ${format} decompression. Use a compatible Node.js runtime or request unresolved data.`
    );
  }

  const result = decompress(payload);
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
}

export function normalizeSerializedData(value: unknown): unknown {
  const format = peekSerializationFormat(value);
  if (
    format !== SerializationFormat.ZSTD &&
    format !== SerializationFormat.GZIP
  ) {
    return value;
  }
  const bytes = value as Uint8Array;
  return decompress(format, bytes.subarray(format.length));
}

const PAYLOAD_FIELDS = ['input', 'output', 'error'] as const;

function normalizeFields<T extends Record<string, unknown>>(
  value: T,
  fields: readonly string[]
): T {
  return {
    ...value,
    ...Object.fromEntries(
      fields.map((field) => [field, normalizeSerializedData(value[field])])
    ),
  };
}

export function normalizeWorkflowRunData<T extends Record<string, unknown>>(
  run: T
): T {
  return normalizeFields(run, PAYLOAD_FIELDS);
}

export function normalizeStepData<T extends Record<string, unknown>>(
  step: T
): T {
  // Only the resolved payload fields can carry a compression wrapper.
  // `*Ref` fields are RefDescriptor objects (lazy mode), never byte
  // payloads, so they need no normalization.
  return normalizeFields(step, PAYLOAD_FIELDS);
}

export function normalizeHookData<T extends Record<string, unknown>>(
  hook: T
): T {
  return normalizeFields(hook, ['metadata']);
}
