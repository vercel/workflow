import { WorkflowWorldError } from '@workflow/errors';

const FORMAT_PREFIX_LENGTH = 4;
const GZIP_FORMAT_PREFIX = 'gzip';
const ZSTD_FORMAT_PREFIX = 'zstd';
const formatDecoder = new TextDecoder();

const SERIALIZED_DATA_FORMAT_PREFIXES = new Set([
  'devl',
  'encr',
  'encp',
  GZIP_FORMAT_PREFIX,
  ZSTD_FORMAT_PREFIX,
]);

const nodeZlib = (() => {
  try {
    return process.getBuiltinModule('node:zlib');
  } catch {
    return undefined;
  }
})();

function peekFormatPrefix(value: unknown): string | null {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < FORMAT_PREFIX_LENGTH
  ) {
    return null;
  }
  return formatDecoder.decode(value.subarray(0, FORMAT_PREFIX_LENGTH));
}

export function hasSerializedDataFormatPrefix(value: unknown): boolean {
  const format = peekFormatPrefix(value);
  return format !== null && SERIALIZED_DATA_FORMAT_PREFIXES.has(format);
}

function decompress(format: string, payload: Uint8Array): Uint8Array {
  const decompress =
    format === ZSTD_FORMAT_PREFIX
      ? nodeZlib?.zstdDecompressSync
      : nodeZlib?.gunzipSync;

  if (!decompress) {
    throw new WorkflowWorldError(
      `Received ${format}-compressed workflow data, but this Node.js runtime does not support ${format} decompression. Use a compatible Node.js runtime or request unresolved data.`
    );
  }

  return new Uint8Array(decompress(payload));
}

export function normalizeSerializedData(value: unknown): unknown {
  const format = peekFormatPrefix(value);
  if (format !== ZSTD_FORMAT_PREFIX && format !== GZIP_FORMAT_PREFIX) {
    return value;
  }
  const bytes = value as Uint8Array;
  return decompress(format, bytes.subarray(FORMAT_PREFIX_LENGTH));
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
