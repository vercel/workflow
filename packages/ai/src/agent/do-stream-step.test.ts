/**
 * Tests for do-stream-step utilities
 *
 * These tests verify the normalizeFinishReason function handles both
 * AI SDK v5 (string) and AI SDK v6 (object) style finish reasons.
 */
import { describe, expect, it } from 'vitest';
import { normalizeFinishReason } from './do-stream-step.js';

describe('normalizeFinishReason', () => {
  describe('AI SDK v5 style (string finish reasons)', () => {
    it('should pass through "stop" string finish reason', () => {
      expect(normalizeFinishReason('stop')).toBe('stop');
    });

    it('should pass through "tool-calls" string finish reason', () => {
      expect(normalizeFinishReason('tool-calls')).toBe('tool-calls');
    });

    it('should pass through "length" string finish reason', () => {
      expect(normalizeFinishReason('length')).toBe('length');
    });

    it('should pass through "content-filter" string finish reason', () => {
      expect(normalizeFinishReason('content-filter')).toBe('content-filter');
    });

    it('should pass through "error" string finish reason', () => {
      expect(normalizeFinishReason('error')).toBe('error');
    });

    it('should pass through "other" string finish reason', () => {
      expect(normalizeFinishReason('other')).toBe('other');
    });

    it('should pass through "unknown" string finish reason', () => {
      expect(normalizeFinishReason('unknown')).toBe('unknown');
    });
  });

  describe('AI SDK v6 style (object finish reasons)', () => {
    it('should extract "stop" from object with type property', () => {
      expect(normalizeFinishReason({ type: 'stop' })).toBe('stop');
    });

    it('should extract "tool-calls" from object with type property', () => {
      expect(normalizeFinishReason({ type: 'tool-calls' })).toBe('tool-calls');
    });

    it('should extract "length" from object with type property', () => {
      expect(normalizeFinishReason({ type: 'length' })).toBe('length');
    });

    it('should extract "content-filter" from object with type property', () => {
      expect(normalizeFinishReason({ type: 'content-filter' })).toBe(
        'content-filter'
      );
    });

    it('should extract "error" from object with type property', () => {
      expect(normalizeFinishReason({ type: 'error' })).toBe('error');
    });

    it('should extract "other" from object with type property', () => {
      expect(normalizeFinishReason({ type: 'other' })).toBe('other');
    });

    it('should extract "unknown" from object with type property', () => {
      expect(normalizeFinishReason({ type: 'unknown' })).toBe('unknown');
    });

    it('should return "unknown" for object without type property', () => {
      expect(normalizeFinishReason({})).toBe('unknown');
    });

    it('should return "unknown" for object with null type property', () => {
      expect(normalizeFinishReason({ type: null })).toBe('unknown');
    });

    it('should return "unknown" for object with undefined type property', () => {
      expect(normalizeFinishReason({ type: undefined })).toBe('unknown');
    });

    it('should handle object with additional properties', () => {
      expect(
        normalizeFinishReason({
          type: 'stop',
          reason: 'end_turn',
          metadata: { foo: 'bar' },
        })
      ).toBe('stop');
    });
  });

  describe('edge cases', () => {
    it('should return "unknown" for undefined', () => {
      expect(normalizeFinishReason(undefined)).toBe('unknown');
    });

    it('should return "unknown" for null', () => {
      expect(normalizeFinishReason(null)).toBe('unknown');
    });

    it('should return "unknown" for number', () => {
      expect(normalizeFinishReason(42)).toBe('unknown');
    });

    it('should return "unknown" for boolean', () => {
      expect(normalizeFinishReason(true)).toBe('unknown');
    });

    it('should return "unknown" for array', () => {
      // Arrays are objects but don't have a valid type property
      expect(normalizeFinishReason(['stop'])).toBe('unknown');
    });

    it('should handle empty string', () => {
      // Empty string is falsy but still a string type
      expect(normalizeFinishReason('')).toBe('');
    });
  });

  describe('original bug reproduction: [object Object] error', () => {
    /**
     * This test reproduces the original bug where AI SDK v6 returned
     * finishReason as an object like { type: 'stop' } instead of just 'stop',
     * causing the error: "Unexpected finish reason: [object Object]"
     */
    it('should handle the exact object format that caused the original bug', () => {
      // This is the format that was causing the error in production
      const objectFinishReason = { type: 'stop' };

      // Before the fix, this would have been compared as a string and failed
      // all the equality checks, eventually throwing:
      // "Unexpected finish reason: [object Object]"
      const normalized = normalizeFinishReason(objectFinishReason);

      expect(normalized).toBe('stop');
      expect(typeof normalized).toBe('string');
    });

    it('should handle tool-calls object format that caused streaming to fail', () => {
      // The bug also affected tool-calls which would break the agent loop
      const objectFinishReason = { type: 'tool-calls' };
      const normalized = normalizeFinishReason(objectFinishReason);

      expect(normalized).toBe('tool-calls');
      expect(typeof normalized).toBe('string');
    });
  });
});
