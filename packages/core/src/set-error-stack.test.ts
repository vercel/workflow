import { describe, expect, it } from 'vitest';
import { setErrorStack } from './set-error-stack.js';

describe('setErrorStack', () => {
  it('replaces a writable stack', () => {
    const error = new Error('boom');
    setErrorStack(error, 'Error: boom\n    at remapped (a.ts:1:1)');
    expect(error.stack).toBe('Error: boom\n    at remapped (a.ts:1:1)');
  });

  it('redefines a stack made read-only the way postgres.js does', () => {
    const error = new Error('boom');
    Object.defineProperties(error, { stack: { value: 'original' } });
    expect(() => {
      error.stack = 'assigned';
    }).toThrow(TypeError);
    setErrorStack(error, 'replaced');
    expect(error.stack).toBe('replaced');
  });

  it('keeps a non-writable, non-configurable stack without throwing', () => {
    const error = new Error('boom');
    Object.defineProperty(error, 'stack', {
      value: 'original',
      writable: false,
      configurable: false,
    });
    expect(() => setErrorStack(error, 'replaced')).not.toThrow();
    expect(error.stack).toBe('original');
  });
});
