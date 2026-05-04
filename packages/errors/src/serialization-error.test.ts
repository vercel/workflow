import { describe, expect, test } from 'vitest';
import { FatalError, SerializationError, WorkflowError } from './index.js';

describe('SerializationError', () => {
  test('sets the name and extends WorkflowError', () => {
    const err = new SerializationError('boom');
    expect(err.name).toBe('SerializationError');
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err).toBeInstanceOf(SerializationError);
  });

  test('renders just the title when no hint is provided', () => {
    // The class no longer attaches a slug-based `╰▶ docs:` line —
    // its in-product hint (added by `formatSerializationError` in
    // `@workflow/core`) carries the foundations URL inline, so the
    // bare-title case stays a single line.
    const err = new SerializationError('boom');
    expect(err.message).toBe('boom');
  });

  test('renders the hint as a framed `╰▶ hint:` branch', () => {
    const err = new SerializationError('boom', {
      hint: 'Register the class with WORKFLOW_SERIALIZE.',
    });
    expect(err.hint).toBe('Register the class with WORKFLOW_SERIALIZE.');
    expect(err.message).toMatchInlineSnapshot(`
      "boom
      ╰▶ hint: Register the class with WORKFLOW_SERIALIZE."
    `);
  });

  test('preserves cause for debugging', () => {
    const cause = new TypeError('underlying');
    const err = new SerializationError('boom', { cause });
    expect(err.cause).toBe(cause);
  });

  test('SerializationError.is discriminates by name', () => {
    const err = new SerializationError('boom');
    const other = new Error('boom');
    expect(SerializationError.is(err)).toBe(true);
    expect(SerializationError.is(other)).toBe(false);
    expect(SerializationError.is(null)).toBe(false);
  });

  test('is fatal — FatalError.is() short-circuits retry loop', () => {
    // Serialization failures are deterministic. Retrying a step that
    // returned a non-POJO will produce the same error on every attempt,
    // so the step handler should not burn the retry budget. We opt in
    // via a `fatal: true` own property that FatalError.is() recognizes.
    const err = new SerializationError('boom');
    expect(err.fatal).toBe(true);
    expect(FatalError.is(err)).toBe(true);
  });
});
