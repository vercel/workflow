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
});
