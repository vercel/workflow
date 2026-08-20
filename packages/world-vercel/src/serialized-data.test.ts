import * as zlib from 'node:zlib';
import { peekSerializationFormat } from '@workflow/world/serialization-format.js';
import { describe, expect, it } from 'vitest';
import { normalizeSerializedData } from './serialized-data.js';

const encoder = new TextEncoder();

function envelope(format: string, payload: Uint8Array): Uint8Array {
  const data = new Uint8Array(4 + payload.length);
  data.set(encoder.encode(format));
  data.set(payload, 4);
  return data;
}

describe('serialized data normalization', () => {
  it.each([
    'devl',
    'encr',
    'encp',
    'gzip',
    'zstd',
  ])('recognizes the %s envelope', (format) => {
    expect(peekSerializationFormat(envelope(format, new Uint8Array()))).toBe(
      format
    );
  });

  it('leaves non-compressed envelopes untouched', () => {
    const encrypted = envelope('encr', new Uint8Array([1, 2, 3]));
    expect(normalizeSerializedData(encrypted)).toBe(encrypted);
  });

  it('decompresses gzip envelopes with the shared world codec', () => {
    const original = new TextEncoder().encode('persisted workflow payload');
    const compressed = envelope('gzip', zlib.gzipSync(original));

    expect(normalizeSerializedData(compressed)).toEqual(original);
  });

  it.runIf(typeof zlib.zstdCompressSync === 'function')(
    'decompresses zstd envelopes with the shared world codec',
    () => {
      const original = new TextEncoder().encode('persisted workflow payload');
      const compressed = envelope('zstd', zlib.zstdCompressSync(original));

      expect(normalizeSerializedData(compressed)).toEqual(original);
    }
  );
});
