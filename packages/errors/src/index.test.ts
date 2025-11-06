import { describe, expect, it } from 'vitest';
import { RetryableError } from './index.js';

describe('RetryableError', () => {
  describe('retryAfter handling', () => {
    it('should treat number as milliseconds', () => {
      const error = new RetryableError('Test error', {
        retryAfter: 5000,
      });
      const delay = error.retryAfter.getTime() - Date.now();
      expect(delay).toBeGreaterThan(4900);
      expect(delay).toBeLessThan(5100);
    });

    it('should handle string durations', () => {
      const error = new RetryableError('Test error', {
        retryAfter: '5s',
      });
      const delay = error.retryAfter.getTime() - Date.now();
      expect(delay).toBeGreaterThan(4900);
      expect(delay).toBeLessThan(5100);
    });

    it('should handle Date objects', () => {
      const targetDate = new Date(Date.now() + 5000);
      const error = new RetryableError('Test error', {
        retryAfter: targetDate,
      });
      expect(error.retryAfter.getTime()).toBe(targetDate.getTime());
    });

    it('should default to 1 second when no retryAfter provided', () => {
      const error = new RetryableError('Test error');
      const delay = error.retryAfter.getTime() - Date.now();
      expect(delay).toBeGreaterThan(900);
      expect(delay).toBeLessThan(1100);
    });
  });

  describe('error properties', () => {
    it('should have correct name property', () => {
      const error = new RetryableError('Test error');
      expect(error.name).toBe('RetryableError');
    });

    it('should have correct message property', () => {
      const message = 'This is a test error';
      const error = new RetryableError(message);
      expect(error.message).toBe(message);
    });

    it('should be an instance of Error', () => {
      const error = new RetryableError('Test error');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('RetryableError.is()', () => {
    it('should return true for RetryableError instances', () => {
      const error = new RetryableError('Test error');
      expect(RetryableError.is(error)).toBe(true);
    });

    it('should return false for regular errors', () => {
      const error = new Error('Regular error');
      expect(RetryableError.is(error)).toBe(false);
    });

    it('should return false for non-error values', () => {
      expect(RetryableError.is(null)).toBe(false);
      expect(RetryableError.is(undefined)).toBe(false);
      expect(RetryableError.is('string')).toBe(false);
      expect(RetryableError.is(123)).toBe(false);
      expect(RetryableError.is({})).toBe(false);
    });
  });
});
