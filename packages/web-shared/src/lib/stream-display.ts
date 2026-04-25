/**
 * Maximum number of entries (array elements / object keys) to keep when
 * sanitizing stream data for the tree inspector.
 */
const MAX_DISPLAY_ENTRIES = 200;
const MAX_DISPLAY_DEPTH = 6;

export interface DecodedStreamChunkSource {
  type: string;
  encoding: 'utf-8';
  rawSummary: string;
}

export interface FormattedStreamChunkDisplay {
  text: string;
  decodedFrom?: DecodedStreamChunkSource;
}

export function summarizeArrayBufferView(value: ArrayBufferView): string {
  const ta = value as unknown as {
    length: number;
    constructor: { name: string };
  } & ArrayLike<number>;
  const name = ta.constructor.name;
  const preview = Array.from(
    { length: Math.min(ta.length, 8) },
    (_, i) => ta[i]
  );
  const suffix = ta.length > 8 ? ', …' : '';
  return `${name}(${ta.length}) [${preview.join(', ')}${suffix}]`;
}

function sanitizeDepthLimit(value: unknown): unknown {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object') return '{…}';
  return value;
}

function sanitizeArray(value: unknown[], depth: number): unknown[] {
  if (value.length <= MAX_DISPLAY_ENTRIES) {
    return value.map((v) => sanitizeStreamChunkForDisplay(v, depth + 1));
  }

  const trimmed = value
    .slice(0, MAX_DISPLAY_ENTRIES)
    .map((v) => sanitizeStreamChunkForDisplay(v, depth + 1));
  trimmed.push(`… ${value.length - MAX_DISPLAY_ENTRIES} more items`);
  return trimmed;
}

function sanitizeObject(
  value: Record<string, unknown>,
  depth: number
): Record<string, unknown> {
  const keys = Object.keys(value);
  const out: Record<string, unknown> = {};
  const limit = Math.min(keys.length, MAX_DISPLAY_ENTRIES);
  for (let i = 0; i < limit; i++) {
    out[keys[i]] = sanitizeStreamChunkForDisplay(value[keys[i]], depth + 1);
  }
  if (keys.length > MAX_DISPLAY_ENTRIES) {
    out[`… ${keys.length - MAX_DISPLAY_ENTRIES} more keys`] = '…';
  }
  return out;
}

/**
 * Prepare a hydrated stream chunk for display.
 *
 * Typed arrays are decoded as UTF-8 text when possible, otherwise they become
 * compact summaries. Large arrays/objects are trimmed so react-inspector does
 * not create thousands of DOM nodes for large payloads.
 */
export function sanitizeStreamChunkForDisplay(
  value: unknown,
  depth = 0
): unknown {
  if (value === null || value === undefined) return value;

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return summarizeArrayBufferView(value);
  }

  if (value instanceof ArrayBuffer) {
    return `ArrayBuffer(${value.byteLength})`;
  }

  if (depth >= MAX_DISPLAY_DEPTH) {
    return sanitizeDepthLimit(value);
  }

  if (Array.isArray(value)) {
    return sanitizeArray(value, depth);
  }

  if (typeof value === 'object') {
    return sanitizeObject(value as Record<string, unknown>, depth);
  }

  return value;
}

export function formatStreamChunkForDisplay(
  value: unknown
): FormattedStreamChunkDisplay {
  try {
    if (typeof value === 'string') {
      return { text: value };
    }

    // Add additional decoded display sources here when we support more raw
    // stream chunk types, such as ArrayBuffer or Blob.
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      return formatArrayBufferViewForDisplay(value);
    }

    const safe = sanitizeStreamChunkForDisplay(value);
    return { text: JSON.stringify(safe, null, 2) };
  } catch {
    return { text: '[Serialization Error]' };
  }
}

export function formatArrayBufferViewForDisplay(
  value: ArrayBufferView
): FormattedStreamChunkDisplay {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
    return {
      text,
      decodedFrom: {
        type: value.constructor.name,
        encoding: 'utf-8',
        rawSummary: summarizeArrayBufferView(value),
      },
    };
  } catch {
    return { text: summarizeArrayBufferView(value) };
  }
}
