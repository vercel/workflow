import { describe, expect, it } from 'vitest';
import {
  formatStreamChunkForDisplay,
  sanitizeStreamChunkForDisplay,
} from '../src/lib/stream-display.js';

describe('stream display formatting', () => {
  it('returns string chunks as-is', () => {
    expect(formatStreamChunkForDisplay('plain text')).toEqual({
      text: 'plain text',
    });
  });

  it('decodes typed array chunks as UTF-8 text', () => {
    const chunk = new TextEncoder().encode('AI says hello\n');

    expect(formatStreamChunkForDisplay(chunk)).toEqual({
      text: 'AI says hello\n',
      decodedFrom: {
        type: 'Uint8Array',
        encoding: 'utf-8',
        rawSummary: 'Uint8Array(14) [65, 73, 32, 115, 97, 121, 115, 32, …]',
      },
    });
  });

  it('falls back to compact summaries for binary typed arrays', () => {
    const chunk = new Uint8Array([255, 254, 253]);

    expect(formatStreamChunkForDisplay(chunk)).toEqual({
      text: 'Uint8Array(3) [255, 254, 253]',
    });
  });

  it('keeps large typed arrays compact when sanitized directly', () => {
    const chunk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect(sanitizeStreamChunkForDisplay(chunk)).toBe(
      'Uint8Array(9) [1, 2, 3, 4, 5, 6, 7, 8, …]'
    );
  });
});
