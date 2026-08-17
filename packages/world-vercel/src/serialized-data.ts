import { WorkflowWorldError } from '@workflow/errors';
import { decompressSerializedDataSync } from '@workflow/world/serialization-compression.js';
import {
  peekSerializationFormat,
  SerializationFormat,
} from '@workflow/world/serialization-format.js';

export function normalizeSerializedData(value: unknown): unknown {
  const format = peekSerializationFormat(value);
  if (
    format !== SerializationFormat.ZSTD &&
    format !== SerializationFormat.GZIP
  ) {
    return value;
  }
  const bytes = value as Uint8Array;
  const decompressed = decompressSerializedDataSync(bytes);
  if (decompressed) return decompressed;

  throw new WorkflowWorldError(
    `Received ${format}-compressed workflow data, but this Node.js runtime does not support ${format} decompression. Use a compatible Node.js runtime or request unresolved data.`
  );
}

export function normalizeWorkflowRunData<T extends Record<string, unknown>>(
  run: T
): T {
  return {
    ...run,
    input: normalizeSerializedData(run.input),
    output: normalizeSerializedData(run.output),
    error: normalizeSerializedData(run.error),
  };
}

export function normalizeStepData<T extends Record<string, unknown>>(
  step: T
): T {
  // Only the resolved payload fields can carry a compression wrapper.
  // `*Ref` fields are RefDescriptor objects (lazy mode), never byte
  // payloads, so they need no normalization.
  return {
    ...step,
    input: normalizeSerializedData(step.input),
    output: normalizeSerializedData(step.output),
    error: normalizeSerializedData(step.error),
  };
}

export function normalizeHookData<T extends Record<string, unknown>>(
  hook: T
): T {
  return {
    ...hook,
    metadata: normalizeSerializedData(hook.metadata),
  };
}
