import { WorkflowWorldError } from '@workflow/errors';
import { EVENT_DATA_REF_FIELDS } from '@workflow/world';

const FORMAT_PREFIX_LENGTH = 4;
const GZIP_FORMAT_PREFIX = 'gzip';
const ZSTD_FORMAT_PREFIX = 'zstd';
const formatDecoder = new TextDecoder();
const V4_EXTRA_EVENT_DATA_REF_FIELDS: Record<string, string[]> = {
  run_started: ['input'],
  step_started: ['input'],
};

interface NodeZlibDecode {
  gunzipSync?: (data: Uint8Array) => Uint8Array;
  zstdDecompressSync?: (data: Uint8Array) => Uint8Array;
}

function getNodeZlib(): NodeZlibDecode | undefined {
  try {
    return (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => NodeZlibDecode };
      }
    ).process?.getBuiltinModule?.('node:zlib');
  } catch {
    return undefined;
  }
}

function peekFormatPrefix(value: unknown): string | null {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < FORMAT_PREFIX_LENGTH
  ) {
    return null;
  }
  return formatDecoder.decode(value.subarray(0, FORMAT_PREFIX_LENGTH));
}

function decompress(format: string, payload: Uint8Array): Uint8Array {
  const zlib = getNodeZlib();
  const decompress =
    format === ZSTD_FORMAT_PREFIX ? zlib?.zstdDecompressSync : zlib?.gunzipSync;

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

export function normalizeEventData<T extends Record<string, unknown>>(
  event: T
): T {
  const eventData = event.eventData;
  if (!eventData || typeof eventData !== 'object') {
    return event;
  }

  const eventType = typeof event.eventType === 'string' ? event.eventType : '';
  const refFields = [
    ...new Set([
      ...(EVENT_DATA_REF_FIELDS[eventType] ?? []),
      ...(V4_EXTRA_EVENT_DATA_REF_FIELDS[eventType] ?? []),
    ]),
  ];
  if (refFields.length === 0) {
    return event;
  }

  const normalizedEventData = { ...(eventData as Record<string, unknown>) };
  let changed = false;
  for (const field of refFields) {
    if (!(field in normalizedEventData)) {
      continue;
    }
    const before = normalizedEventData[field];
    const after = normalizeSerializedData(before);
    if (after !== before) {
      normalizedEventData[field] = after;
      changed = true;
    }
  }

  return changed ? { ...event, eventData: normalizedEventData } : event;
}
