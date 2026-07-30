import { runInNewContext } from 'node:vm';
import { FatalError } from '@workflow/errors';
import { describe, expect, it } from 'vitest';
import { isAbortError, promoteAbortErrorToFatal } from './types.js';

describe('isAbortError', () => {
  it('recognizes an AbortError from another realm', () => {
    const error = runInNewContext(
      'Object.assign(new Error("cancelled"), { name: "AbortError" })'
    );

    expect(error).not.toBeInstanceOf(Error);
    expect(isAbortError(error)).toBe(true);
  });

  it.each([
    { name: 'AbortError', message: 'serialized abort' },
    new DOMException('dom abort', 'AbortError'),
  ])('recognizes abort-shaped values', (error) => {
    expect(isAbortError(error)).toBe(true);
  });

  it.each([
    null,
    undefined,
    { name: 'TypeError', message: 'not an abort' },
    { name: 'AbortError' },
    { name: 'AbortError', message: 42 },
    { name: 'AbortError', message: 'bad stack', stack: 42 },
  ])('rejects non-abort values', (value) => {
    expect(isAbortError(value)).toBe(false);
  });
});

describe('promoteAbortErrorToFatal', () => {
  it('promotes an abort-shaped value to FatalError and preserves its stack', () => {
    const error = {
      name: 'AbortError',
      message: 'cancelled',
      stack: 'AbortError: cancelled',
    };

    const promoted = promoteAbortErrorToFatal(error);

    expect(FatalError.is(promoted)).toBe(true);
    expect(promoted).toMatchObject({
      name: 'FatalError',
      message: 'Aborted: cancelled',
      stack: error.stack,
    });
  });

  it('preserves an already fatal abort error', () => {
    const error = Object.assign(new FatalError('already fatal'), {
      name: 'AbortError',
    });

    expect(promoteAbortErrorToFatal(error)).toBe(error);
  });
});
