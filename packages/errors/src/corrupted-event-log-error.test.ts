import { describe, expect, test } from 'vitest';
import {
  CorruptedEventLogError,
  WorkflowError,
  WorkflowRuntimeError,
} from './index.js';

describe('CorruptedEventLogError', () => {
  test('sets the name and extends WorkflowRuntimeError', () => {
    const err = new CorruptedEventLogError('event mismatch');
    expect(err.name).toBe('CorruptedEventLogError');
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err).toBeInstanceOf(WorkflowRuntimeError);
    expect(err).toBeInstanceOf(CorruptedEventLogError);
  });

  test('adds the corrupted event log docs link', () => {
    const err = new CorruptedEventLogError('event mismatch');
    expect(err.message).toContain(
      'https://workflow-sdk.dev/err/corrupted-event-log'
    );
  });

  test('preserves cause for debugging', () => {
    const cause = new Error('underlying mismatch');
    const err = new CorruptedEventLogError('event mismatch', { cause });
    expect(err.cause).toBe(cause);
  });

  test('CorruptedEventLogError.is discriminates by name', () => {
    const err = new CorruptedEventLogError('event mismatch');
    const other = new Error('event mismatch');
    expect(CorruptedEventLogError.is(err)).toBe(true);
    expect(CorruptedEventLogError.is(other)).toBe(false);
    expect(CorruptedEventLogError.is(null)).toBe(false);
  });
});
