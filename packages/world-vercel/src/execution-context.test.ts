import { WorkflowRuntimeError } from '@workflow/errors';
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

  it('rejects 2049 JSON UTF-8 bytes with a typed error naming the measured size', () => {
    let error: unknown;
    try {
      validateRunExecutionContext(
        contextAtSize(MAX_EXECUTION_CONTEXT_BYTES + 1)
      );
    } catch (err) {
      error = err;
    }
    expect(WorkflowRuntimeError.is(error)).toBe(true);
    expect((error as Error).message).toMatch(
      /Dynamic workflow execution context is 2049 bytes.*2048-byte limit.*experimental_dynamic\.steps/
    );
  });

  it('rejects a context that is not JSON serializable with a typed error', () => {
    expect(() => validateRunExecutionContext({ value: 1n })).toThrow(
      WorkflowRuntimeError
    );
  });
});
