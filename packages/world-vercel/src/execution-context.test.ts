import { describe, expect, it } from 'vitest';
import {
  MAX_EXECUTION_CONTEXT_BYTES,
  validateRunExecutionContext,
} from './execution-context.js';

describe('validateRunExecutionContext', () => {
  function contextAtSize(bytes: number): Record<string, unknown> {
    const emptyBytes = new TextEncoder().encode(
      JSON.stringify({ value: '' })
    ).byteLength;
    return { value: 'x'.repeat(bytes - emptyBytes) };
  }

  it('accepts exactly 2048 JSON UTF-8 bytes', () => {
    expect(() =>
      validateRunExecutionContext(contextAtSize(MAX_EXECUTION_CONTEXT_BYTES))
    ).not.toThrow();
  });

  it('rejects 2049 JSON UTF-8 bytes with the measured size', () => {
    expect(() =>
      validateRunExecutionContext(
        contextAtSize(MAX_EXECUTION_CONTEXT_BYTES + 1)
      )
    ).toThrow(/2049 bytes.*2048-byte limit.*Dynamic step metadata/);
  });
});
