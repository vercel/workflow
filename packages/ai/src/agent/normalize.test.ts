import { describe, expect, it } from 'vitest';
import {
  addUsage,
  normalizeFinishReason,
  normalizeUsage,
  type NormalizedUsage,
} from './normalize.js';

const EMPTY_INPUT_DETAILS = {
  noCacheTokens: undefined,
  cacheReadTokens: undefined,
  cacheWriteTokens: undefined,
};

const EMPTY_OUTPUT_DETAILS = {
  textTokens: undefined,
  reasoningTokens: undefined,
};

describe('normalizeFinishReason', () => {
  describe('null/undefined', () => {
    it('should return "unknown" for null', () => {
      expect(normalizeFinishReason(null)).toEqual({
        finishReason: 'unknown',
        rawFinishReason: undefined,
      });
    });

    it('should return "unknown" for undefined', () => {
      expect(normalizeFinishReason(undefined)).toEqual({
        finishReason: 'unknown',
        rawFinishReason: undefined,
      });
    });
  });

  describe('string passthrough', () => {
    it('should pass through "stop"', () => {
      expect(normalizeFinishReason('stop')).toEqual({
        finishReason: 'stop',
        rawFinishReason: 'stop',
      });
    });

    it('should pass through "tool-calls"', () => {
      expect(normalizeFinishReason('tool-calls')).toEqual({
        finishReason: 'tool-calls',
        rawFinishReason: 'tool-calls',
      });
    });

    it('should pass through "length"', () => {
      expect(normalizeFinishReason('length')).toEqual({
        finishReason: 'length',
        rawFinishReason: 'length',
      });
    });

    it('should pass through "content-filter"', () => {
      expect(normalizeFinishReason('content-filter')).toEqual({
        finishReason: 'content-filter',
        rawFinishReason: 'content-filter',
      });
    });

    it('should pass through "error"', () => {
      expect(normalizeFinishReason('error')).toEqual({
        finishReason: 'error',
        rawFinishReason: 'error',
      });
    });

    it('should pass through "unknown"', () => {
      expect(normalizeFinishReason('unknown')).toEqual({
        finishReason: 'unknown',
        rawFinishReason: 'unknown',
      });
    });

    it('should return "unknown" for empty string', () => {
      expect(normalizeFinishReason('')).toEqual({
        finishReason: 'unknown',
        rawFinishReason: undefined,
      });
    });
  });

  describe('V3 format ({unified, raw})', () => {
    it('should extract "stop" from V3 format', () => {
      expect(
        normalizeFinishReason({ unified: 'stop', raw: 'stop_sequence' })
      ).toEqual({
        finishReason: 'stop',
        rawFinishReason: 'stop_sequence',
      });
    });

    it('should extract "tool-calls" from V3 format', () => {
      expect(
        normalizeFinishReason({ unified: 'tool-calls', raw: 'tool_use' })
      ).toEqual({
        finishReason: 'tool-calls',
        rawFinishReason: 'tool_use',
      });
    });

    it('should extract "length" from V3 format', () => {
      expect(
        normalizeFinishReason({ unified: 'length', raw: 'max_tokens' })
      ).toEqual({
        finishReason: 'length',
        rawFinishReason: 'max_tokens',
      });
    });
  });

  describe('V2 object fallback ({type})', () => {
    it('should extract "stop" from V2 object', () => {
      expect(normalizeFinishReason({ type: 'stop' })).toEqual({
        finishReason: 'stop',
        rawFinishReason: undefined,
      });
    });

    it('should extract "tool-calls" from V2 object', () => {
      expect(normalizeFinishReason({ type: 'tool-calls' })).toEqual({
        finishReason: 'tool-calls',
        rawFinishReason: undefined,
      });
    });

    it('should extract "length" from V2 object', () => {
      expect(normalizeFinishReason({ type: 'length' })).toEqual({
        finishReason: 'length',
        rawFinishReason: undefined,
      });
    });

    it('should extract "content-filter" from V2 object', () => {
      expect(normalizeFinishReason({ type: 'content-filter' })).toEqual({
        finishReason: 'content-filter',
        rawFinishReason: undefined,
      });
    });

    it('should extract "error" from V2 object', () => {
      expect(normalizeFinishReason({ type: 'error' })).toEqual({
        finishReason: 'error',
        rawFinishReason: undefined,
      });
    });

    it('should extract "other" from V2 object', () => {
      expect(normalizeFinishReason({ type: 'other' })).toEqual({
        finishReason: 'other',
        rawFinishReason: undefined,
      });
    });

    it('should extract "unknown" from V2 object', () => {
      expect(normalizeFinishReason({ type: 'unknown' })).toEqual({
        finishReason: 'unknown',
        rawFinishReason: undefined,
      });
    });

    it('should return "unknown" for object with null type', () => {
      expect(normalizeFinishReason({ type: null })).toEqual({
        finishReason: 'unknown',
        rawFinishReason: undefined,
      });
    });

    it('should return "unknown" for object with undefined type', () => {
      expect(normalizeFinishReason({ type: undefined })).toEqual({
        finishReason: 'unknown',
        rawFinishReason: undefined,
      });
    });

    it('should handle object with additional properties', () => {
      expect(
        normalizeFinishReason({
          type: 'stop',
          reason: 'end_turn',
          metadata: { foo: 'bar' },
        })
      ).toEqual({
        finishReason: 'stop',
        rawFinishReason: undefined,
      });
    });

    it('should extract raw from V2 object with raw field', () => {
      expect(normalizeFinishReason({ type: 'stop', raw: 'end_turn' })).toEqual({
        finishReason: 'stop',
        rawFinishReason: 'end_turn',
      });
    });
  });

  describe('edge cases', () => {
    it('should return "unknown" for empty object', () => {
      expect(normalizeFinishReason({})).toEqual({
        finishReason: 'unknown',
        rawFinishReason: undefined,
      });
    });

    it('should return "unknown" for number', () => {
      expect(normalizeFinishReason(42)).toEqual({
        finishReason: 'unknown',
        rawFinishReason: undefined,
      });
    });

    it('should return "unknown" for boolean', () => {
      expect(normalizeFinishReason(true)).toEqual({
        finishReason: 'unknown',
        rawFinishReason: undefined,
      });
    });

    it('should return "unknown" for array', () => {
      expect(normalizeFinishReason(['stop'])).toEqual({
        finishReason: 'unknown',
        rawFinishReason: undefined,
      });
    });
  });

  describe('bug reproduction', () => {
    it('should handle object format that caused [object Object] error', () => {
      const normalized = normalizeFinishReason({ type: 'stop' });
      expect(normalized.finishReason).toBe('stop');
      expect(typeof normalized.finishReason).toBe('string');
    });

    it('should handle tool-calls object format', () => {
      const normalized = normalizeFinishReason({ type: 'tool-calls' });
      expect(normalized.finishReason).toBe('tool-calls');
      expect(typeof normalized.finishReason).toBe('string');
    });
  });
});

describe('normalizeUsage', () => {
  describe('null/undefined', () => {
    it('should return zeroes for null', () => {
      expect(normalizeUsage(null)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });

    it('should return zeroes for undefined', () => {
      expect(normalizeUsage(undefined)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });
  });

  describe('V2 flat format', () => {
    it('should pass through V2 usage with totalTokens', () => {
      expect(
        normalizeUsage({ inputTokens: 10, outputTokens: 20, totalTokens: 30 })
      ).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });

    it('should compute totalTokens when missing in V2 format', () => {
      expect(normalizeUsage({ inputTokens: 10, outputTokens: 20 })).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });

    it('should preserve cachedInputTokens in inputTokenDetails', () => {
      expect(
        normalizeUsage({
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 80,
        })
      ).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: 80,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });

    it('should preserve reasoningTokens in outputTokenDetails', () => {
      expect(
        normalizeUsage({
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 30,
        })
      ).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: 30,
        },
      });
    });

    it('should preserve raw field when present', () => {
      const result = normalizeUsage({
        inputTokens: 10,
        outputTokens: 20,
        raw: { custom: 'data' },
      });
      expect(result.raw).toEqual({ custom: 'data' });
    });
  });

  describe('V3 nested format', () => {
    it('should extract totals from V3 nested usage', () => {
      expect(
        normalizeUsage({
          inputTokens: { total: 10 },
          outputTokens: { total: 20 },
        })
      ).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });

    it('should handle V3 partial usage (only inputTokens)', () => {
      expect(normalizeUsage({ inputTokens: { total: 10 } })).toEqual({
        inputTokens: 10,
        outputTokens: 0,
        totalTokens: 10,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });

    it('should handle V3 partial usage (only outputTokens)', () => {
      expect(normalizeUsage({ outputTokens: { total: 20 } })).toEqual({
        inputTokens: 0,
        outputTokens: 20,
        totalTokens: 20,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });

    it('should extract detailed breakdowns from V3 format', () => {
      expect(
        normalizeUsage({
          inputTokens: {
            total: 100,
            noCache: 20,
            cacheRead: 60,
            cacheWrite: 20,
          },
          outputTokens: { total: 50, text: 40, reasoning: 10 },
        })
      ).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        inputTokenDetails: {
          noCacheTokens: 20,
          cacheReadTokens: 60,
          cacheWriteTokens: 20,
        },
        outputTokenDetails: {
          textTokens: 40,
          reasoningTokens: 10,
        },
      });
    });

    it('should preserve raw field from V3 format', () => {
      const result = normalizeUsage({
        inputTokens: { total: 10 },
        outputTokens: { total: 20 },
        raw: { provider_data: 'value' },
      });
      expect(result.raw).toEqual({ provider_data: 'value' });
    });
  });

  describe('edge cases', () => {
    it('should return zeroes for empty object', () => {
      expect(normalizeUsage({})).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });

    it('should return zeroes for non-object', () => {
      expect(normalizeUsage(42)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });

    it('should return zeroes for array', () => {
      expect(normalizeUsage([10, 20])).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });

    it('should return zeroes when only outputTokens is a number (V2 branch requires inputTokens)', () => {
      expect(normalizeUsage({ outputTokens: 20 })).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: EMPTY_INPUT_DETAILS,
        outputTokenDetails: EMPTY_OUTPUT_DETAILS,
      });
    });
  });
});

describe('addUsage', () => {
  const emptyUsage: NormalizedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
  };

  it('should add two usage objects with basic tokens', () => {
    const a: NormalizedUsage = {
      ...emptyUsage,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    };
    const b: NormalizedUsage = {
      ...emptyUsage,
      inputTokens: 5,
      outputTokens: 15,
      totalTokens: 20,
    };
    expect(addUsage(a, b)).toEqual({
      inputTokens: 15,
      outputTokens: 35,
      totalTokens: 50,
      inputTokenDetails: EMPTY_INPUT_DETAILS,
      outputTokenDetails: EMPTY_OUTPUT_DETAILS,
    });
  });

  it('should sum detail fields when both are present', () => {
    const a: NormalizedUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: {
        noCacheTokens: 20,
        cacheReadTokens: 60,
        cacheWriteTokens: 20,
      },
      outputTokenDetails: {
        textTokens: 40,
        reasoningTokens: 10,
      },
    };
    const b: NormalizedUsage = {
      inputTokens: 80,
      outputTokens: 30,
      totalTokens: 110,
      inputTokenDetails: {
        noCacheTokens: 10,
        cacheReadTokens: 50,
        cacheWriteTokens: 20,
      },
      outputTokenDetails: {
        textTokens: 20,
        reasoningTokens: 10,
      },
    };
    expect(addUsage(a, b)).toEqual({
      inputTokens: 180,
      outputTokens: 80,
      totalTokens: 260,
      inputTokenDetails: {
        noCacheTokens: 30,
        cacheReadTokens: 110,
        cacheWriteTokens: 40,
      },
      outputTokenDetails: {
        textTokens: 60,
        reasoningTokens: 20,
      },
    });
  });

  it('should keep undefined when both detail fields are undefined', () => {
    expect(addUsage(emptyUsage, emptyUsage)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokenDetails: EMPTY_INPUT_DETAILS,
      outputTokenDetails: EMPTY_OUTPUT_DETAILS,
    });
  });

  it('should treat undefined as 0 when only one side has a value', () => {
    const a: NormalizedUsage = {
      ...emptyUsage,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      inputTokenDetails: {
        ...emptyUsage.inputTokenDetails,
        cacheReadTokens: 8,
      },
    };
    expect(addUsage(a, emptyUsage)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: 8,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: EMPTY_OUTPUT_DETAILS,
    });
  });
});
