import { describe, expect, test } from 'vitest';
import {
  EncryptionKeyLookupError,
  FatalError,
  WorkflowError,
  WorkflowRuntimeError,
} from './index.js';

describe('EncryptionKeyLookupError', () => {
  test('sets the name and extends WorkflowRuntimeError', () => {
    const err = new EncryptionKeyLookupError('key lookup failed');
    expect(err.name).toBe('EncryptionKeyLookupError');
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err).toBeInstanceOf(WorkflowRuntimeError);
    expect(EncryptionKeyLookupError.is(err)).toBe(true);
  });

  test('is fatal', () => {
    expect(
      FatalError.is(new EncryptionKeyLookupError('key lookup failed'))
    ).toBe(true);
  });

  test('preserves cause for debugging', () => {
    const cause = new Error('404 Not Found');
    const err = new EncryptionKeyLookupError('key lookup failed', { cause });
    expect(err.cause).toBe(cause);
  });
});
