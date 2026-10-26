import { describe, expect, test } from 'vitest';
import {
  FatalError,
  NonTransientEncryptionKeyLookupError,
  WorkflowError,
  WorkflowRuntimeError,
} from './index.js';

describe('NonTransientEncryptionKeyLookupError', () => {
  test('sets the name and extends WorkflowRuntimeError', () => {
    const err = new NonTransientEncryptionKeyLookupError('key lookup failed');
    expect(err.name).toBe('NonTransientEncryptionKeyLookupError');
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err).toBeInstanceOf(WorkflowRuntimeError);
    expect(NonTransientEncryptionKeyLookupError.is(err)).toBe(true);
  });

  test('is fatal', () => {
    expect(
      FatalError.is(
        new NonTransientEncryptionKeyLookupError('key lookup failed')
      )
    ).toBe(true);
  });

  test('preserves cause for debugging', () => {
    const cause = new Error('404 Not Found');
    const err = new NonTransientEncryptionKeyLookupError('key lookup failed', {
      cause,
    });
    expect(err.cause).toBe(cause);
  });
});
