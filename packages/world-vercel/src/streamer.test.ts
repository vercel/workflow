import { describe, expect, it } from 'vitest';
import { encodeMultiChunks } from './streamer.js';

describe('encodeMultiChunks', () => {
  /**
   * Helper to decode length-prefixed chunks back to verify encoding
   */
  function decodeMultiChunks(encoded: Uint8Array): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    const view = new DataView(
      encoded.buffer,
      encoded.byteOffset,
      encoded.byteLength
    );
    let offset = 0;

    while (offset < encoded.length) {
      const length = view.getUint32(offset, false); // big-endian
      offset += 4;
      chunks.push(encoded.slice(offset, offset + length));
      offset += length;
    }

    return chunks;
  }

  it('should encode an empty array', () => {
    const result = encodeMultiChunks([]);
    expect(result.length).toBe(0);
  });

  it('should encode a single string chunk', () => {
    const result = encodeMultiChunks(['hello']);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(1);
    expect(new TextDecoder().decode(decoded[0])).toBe('hello');
  });

  it('should encode a single Uint8Array chunk', () => {
    const chunk = new Uint8Array([1, 2, 3, 4, 5]);
    const result = encodeMultiChunks([chunk]);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(chunk);
  });

  it('should encode multiple string chunks', () => {
    const result = encodeMultiChunks(['hello', 'world', 'test']);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(new TextDecoder().decode(decoded[0])).toBe('hello');
    expect(new TextDecoder().decode(decoded[1])).toBe('world');
    expect(new TextDecoder().decode(decoded[2])).toBe('test');
  });

  it('should encode multiple Uint8Array chunks', () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6, 7, 8, 9]),
    ];
    const result = encodeMultiChunks(chunks);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toEqual(chunks[0]);
    expect(decoded[1]).toEqual(chunks[1]);
    expect(decoded[2]).toEqual(chunks[2]);
  });

  it('should encode mixed string and Uint8Array chunks', () => {
    const result = encodeMultiChunks([
      'hello',
      new Uint8Array([1, 2, 3]),
      'world',
    ]);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(new TextDecoder().decode(decoded[0])).toBe('hello');
    expect(decoded[1]).toEqual(new Uint8Array([1, 2, 3]));
    expect(new TextDecoder().decode(decoded[2])).toBe('world');
  });

  it('should handle empty string chunks', () => {
    const result = encodeMultiChunks(['', 'hello', '']);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(decoded[0].length).toBe(0);
    expect(new TextDecoder().decode(decoded[1])).toBe('hello');
    expect(decoded[2].length).toBe(0);
  });

  it('should handle empty Uint8Array chunks', () => {
    const result = encodeMultiChunks([
      new Uint8Array([]),
      new Uint8Array([1, 2]),
      new Uint8Array([]),
    ]);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(decoded[0].length).toBe(0);
    expect(decoded[1]).toEqual(new Uint8Array([1, 2]));
    expect(decoded[2].length).toBe(0);
  });

  it('should correctly calculate total size with length prefixes', () => {
    // Each chunk has a 4-byte length prefix
    // 'hello' = 5 bytes, 'world' = 5 bytes
    // Total = 4 + 5 + 4 + 5 = 18 bytes
    const result = encodeMultiChunks(['hello', 'world']);
    expect(result.length).toBe(18);
  });

  it('should use big-endian encoding for length prefix', () => {
    const result = encodeMultiChunks(['hello']);
    const view = new DataView(
      result.buffer,
      result.byteOffset,
      result.byteLength
    );

    // 'hello' is 5 bytes, big-endian encoding of 5 is [0, 0, 0, 5]
    expect(view.getUint32(0, false)).toBe(5);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(0);
    expect(result[3]).toBe(5);
  });

  it('should handle large chunks', () => {
    // Create a 10KB chunk
    const largeChunk = new Uint8Array(10 * 1024);
    for (let i = 0; i < largeChunk.length; i++) {
      largeChunk[i] = i % 256;
    }

    const result = encodeMultiChunks([largeChunk]);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(largeChunk);
  });

  it('should handle many small chunks', () => {
    const chunks = Array.from({ length: 100 }, (_, i) => `chunk${i}`);
    const result = encodeMultiChunks(chunks);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(100);
    decoded.forEach((chunk, i) => {
      expect(new TextDecoder().decode(chunk)).toBe(`chunk${i}`);
    });
  });

  it('should handle unicode strings correctly', () => {
    const result = encodeMultiChunks(['hello', '世界', '🚀']);
    const decoded = decodeMultiChunks(result);

    expect(decoded).toHaveLength(3);
    expect(new TextDecoder().decode(decoded[0])).toBe('hello');
    expect(new TextDecoder().decode(decoded[1])).toBe('世界');
    expect(new TextDecoder().decode(decoded[2])).toBe('🚀');
  });
});
