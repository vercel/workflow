import { describe, expect, it } from 'vitest';
import { getStreamImageType } from './stream-image';

const encode = (text: string) => new TextEncoder().encode(text);

describe('getStreamImageType', () => {
  it.each([
    ['image/png', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10)],
    ['image/jpeg', Uint8Array.of(0xff, 0xd8, 0xff)],
    ['image/gif', encode('GIF87a')],
    ['image/gif', encode('GIF89a')],
    ['image/webp', encode('RIFF1234WEBP')],
  ])('recognizes %s from bytes, including subarrays', (type, bytes) => {
    expect(getStreamImageType(bytes as Uint8Array)).toBe(type);
    const wrapped = new Uint8Array((bytes as Uint8Array).length + 2);
    wrapped.set(bytes as Uint8Array, 1);
    expect(getStreamImageType(wrapped.subarray(1, -1))).toBe(type);
  });

  it.each([
    '',
    'PNG',
    'GIF89',
    'RIFF1234WAVE',
    '<svg></svg>',
    'image/png',
    'plain text',
  ])('leaves non-images unchanged: %s', (text) => {
    expect(getStreamImageType(encode(text))).toBeNull();
  });
});
