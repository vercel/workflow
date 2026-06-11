import { describe, expect, test } from 'vitest';
import {
  RuntimeDecryptionError,
  WorkflowError,
  WorkflowRuntimeError,
} from './index.js';

describe('RuntimeDecryptionError', () => {
  test('sets the name and extends WorkflowRuntimeError', () => {
    const err = new RuntimeDecryptionError('decrypt failed');
    expect(err.name).toBe('RuntimeDecryptionError');
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err).toBeInstanceOf(WorkflowRuntimeError);
    expect(err).toBeInstanceOf(RuntimeDecryptionError);
  });

  test('adds the runtime-decryption-failed docs link', () => {
    const err = new RuntimeDecryptionError('decrypt failed');
    expect(err.message).toContain(
      'https://workflow-sdk.dev/err/runtime-decryption-failed'
    );
  });

  test('preserves cause for debugging', () => {
    const cause = new Error('underlying OperationError');
    const err = new RuntimeDecryptionError('decrypt failed', { cause });
    expect(err.cause).toBe(cause);
  });

  test('records optional diagnostic context', () => {
    const err = new RuntimeDecryptionError('decrypt failed', {
      context: {
        operation: 'decrypt',
        byteLength: 42,
        formatPrefix: 'encr',
      },
    });
    expect(err.context).toEqual({
      operation: 'decrypt',
      byteLength: 42,
      formatPrefix: 'encr',
    });
  });

  test('omits the context property when not provided', () => {
    const err = new RuntimeDecryptionError('decrypt failed');
    expect('context' in err).toBe(false);
  });

  test('RuntimeDecryptionError.is discriminates by name', () => {
    const err = new RuntimeDecryptionError('decrypt failed');
    const other = new Error('decrypt failed');
    const runtimeOnly = new WorkflowRuntimeError('decrypt failed');
    expect(RuntimeDecryptionError.is(err)).toBe(true);
    // .is() is a name-based duck check, so a plain WorkflowRuntimeError
    // does NOT pass — subclassing alone is not enough.
    expect(RuntimeDecryptionError.is(runtimeOnly)).toBe(false);
    expect(RuntimeDecryptionError.is(other)).toBe(false);
    expect(RuntimeDecryptionError.is(null)).toBe(false);
    expect(RuntimeDecryptionError.is(undefined)).toBe(false);
  });
});
