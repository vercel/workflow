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

const WORKFLOW_FORMAT_PREFIXES = new Set(['devl', 'encr', 'gzip', 'zstd']);

function peekAsciiPrefix(value: ArrayBufferView): string | null {
  if (value.byteLength < 4) return null;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, 4);
  let prefix = '';
  for (const byte of bytes) {
    if (byte < 0x61 || byte > 0x7a) return null;
    prefix += String.fromCharCode(byte);
  }
  return WORKFLOW_FORMAT_PREFIXES.has(prefix) ? prefix : null;
}

/**
 * Decode a typed array as UTF-8 text when valid, otherwise return a compact
 * raw-byte summary. Used by `DataInspector`'s `collapseRefs` pipeline so
 * hydrated `Uint8Array` chunks (e.g. AI SDK text deltas) render as readable
 * text while still exposing the underlying byte layout.
 *
 * Workflow serialization payloads (`devl` / `gzip` / `zstd` / `encr`) are
 * never UTF-8 text the user should read raw — leave a clear summary so the
 * caller can tell hydration did not run, instead of dumping binary noise.
 */
export function formatArrayBufferViewForDisplay(
  value: ArrayBufferView
): FormattedStreamChunkDisplay {
  const formatPrefix = peekAsciiPrefix(value);
  if (formatPrefix) {
    return {
      text: `SerializedData(${formatPrefix}, ${value.byteLength} bytes)`,
    };
  }
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
