import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './get-error-message.js';

describe('getErrorMessage', () => {
  it('should return message from Error instance', () => {
    expect(getErrorMessage(new Error('something broke'))).toBe(
      'something broke'
    );
  });

  it('should return string errors as-is', () => {
    expect(getErrorMessage('plain string error')).toBe('plain string error');
  });

  it('should JSON-serialize plain objects instead of [object Object]', () => {
    const error = { code: 'STREAM_FAILED', detail: 'token limit' };
    const msg = getErrorMessage(error);
    expect(msg).not.toBe('[object Object]');
    expect(msg).toBe(JSON.stringify(error));
  });

  it('should JSON-serialize nested objects', () => {
    const error = { outer: { inner: 'value' } };
    expect(getErrorMessage(error)).toBe(JSON.stringify(error));
  });

  it('should return "unknown error" for null', () => {
    expect(getErrorMessage(null)).toBe('unknown error');
  });

  it('should return "unknown error" for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('unknown error');
  });

  it('should handle number errors', () => {
    expect(getErrorMessage(42)).toBe('42');
  });

  it('should handle boolean errors', () => {
    expect(getErrorMessage(true)).toBe('true');
  });

  it('should handle array errors', () => {
    expect(getErrorMessage(['a', 'b'])).toBe(JSON.stringify(['a', 'b']));
  });

  it('should handle empty string', () => {
    expect(getErrorMessage('')).toBe('');
  });

  it('should handle Error subclass', () => {
    class CustomError extends Error {
      code = 'CUSTOM';
    }
    expect(getErrorMessage(new CustomError('custom msg'))).toBe('custom msg');
  });
});
