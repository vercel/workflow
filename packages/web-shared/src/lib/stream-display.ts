import { peekFormatPrefix } from '@workflow/core/serialization-format';

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

/**
 * Decode a typed array as UTF-8 text when valid, otherwise return a compact
 * raw-byte summary. Used by `DataInspector`'s `collapseRefs` pipeline so
 * hydrated `Uint8Array` chunks (e.g. AI SDK text deltas) render as readable
 * text while still exposing the underlying byte layout.
 *
 * Workflow serialization payloads keep their format prefix summary so
 * un-hydrated `devl`/`gzip`/`zstd`/`encr` blobs are not misread as UTF-8.
 */
export function formatArrayBufferViewForDisplay(
  value: ArrayBufferView
): FormattedStreamChunkDisplay {
  const formatPrefix = peekFormatPrefix(value);
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
