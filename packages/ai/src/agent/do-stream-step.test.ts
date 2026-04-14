import type { UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { doStreamStep, normalizeFinishReason } from './do-stream-step.js';
import { safeParseToolCallInput } from './safe-parse-tool-call-input.js';

describe('normalizeFinishReason', () => {
  describe('string finish reasons', () => {
    it('should pass through "stop"', () => {
      expect(normalizeFinishReason('stop')).toBe('stop');
    });

    it('should pass through "tool-calls"', () => {
      expect(normalizeFinishReason('tool-calls')).toBe('tool-calls');
    });

    it('should pass through "length"', () => {
      expect(normalizeFinishReason('length')).toBe('length');
    });

    it('should pass through "content-filter"', () => {
      expect(normalizeFinishReason('content-filter')).toBe('content-filter');
    });

    it('should pass through "error"', () => {
      expect(normalizeFinishReason('error')).toBe('error');
    });

    it('should pass through "other"', () => {
      expect(normalizeFinishReason('other')).toBe('other');
    });
  });

  describe('object finish reasons', () => {
    it('should extract "stop" from object', () => {
      expect(normalizeFinishReason({ type: 'stop' })).toBe('stop');
    });

    it('should extract "tool-calls" from object', () => {
      expect(normalizeFinishReason({ type: 'tool-calls' })).toBe('tool-calls');
    });

    it('should extract "length" from object', () => {
      expect(normalizeFinishReason({ type: 'length' })).toBe('length');
    });

    it('should extract "content-filter" from object', () => {
      expect(normalizeFinishReason({ type: 'content-filter' })).toBe(
        'content-filter'
      );
    });

    it('should extract "error" from object', () => {
      expect(normalizeFinishReason({ type: 'error' })).toBe('error');
    });

    it('should extract "other" from object', () => {
      expect(normalizeFinishReason({ type: 'other' })).toBe('other');
    });

    it('should return "other" for object with unrecognized type', () => {
      expect(normalizeFinishReason({ type: 'unknown' })).toBe('other');
    });

    it('should return "other" for object without type property', () => {
      expect(normalizeFinishReason({})).toBe('other');
    });

    it('should return "other" for object with null type', () => {
      expect(normalizeFinishReason({ type: null })).toBe('other');
    });

    it('should return "other" for object with undefined type', () => {
      expect(normalizeFinishReason({ type: undefined })).toBe('other');
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
    it('should return "other" for undefined', () => {
      expect(normalizeFinishReason(undefined)).toBe('other');
    });

    it('should return "other" for null', () => {
      expect(normalizeFinishReason(null)).toBe('other');
    });

    it('should return "other" for number', () => {
      expect(normalizeFinishReason(42)).toBe('other');
    });

    it('should return "other" for boolean', () => {
      expect(normalizeFinishReason(true)).toBe('other');
    });

    it('should return "other" for array', () => {
      expect(normalizeFinishReason(['stop'])).toBe('other');
    });

    it('should handle empty string', () => {
      expect(normalizeFinishReason('')).toBe('');
    });
  });

  describe('bug reproduction', () => {
    it('should handle object format that caused [object Object] error', () => {
      const normalized = normalizeFinishReason({ type: 'stop' });
      expect(normalized).toBe('stop');
      expect(typeof normalized).toBe('string');
    });

    it('should handle tool-calls object format', () => {
      const normalized = normalizeFinishReason({ type: 'tool-calls' });
      expect(normalized).toBe('tool-calls');
      expect(typeof normalized).toBe('string');
    });
  });
});

describe('safeParseToolCallInput', () => {
  it('should parse valid JSON input', () => {
    expect(safeParseToolCallInput('{"city":"San Francisco"}')).toEqual({
      city: 'San Francisco',
    });
  });

  it('should return empty object for undefined input', () => {
    expect(safeParseToolCallInput(undefined)).toEqual({});
  });

  it('should preserve malformed input as a string', () => {
    expect(safeParseToolCallInput('{"city":"San Francisco"')).toBe(
      '{"city":"San Francisco"'
    );
  });
});

describe('doStreamStep', () => {
  it('should not throw when streamed tool-call input is malformed JSON', async () => {
    const writtenChunks: UIMessageChunk[] = [];
    const writable = new WritableStream<UIMessageChunk>({
      write: async (chunk) => {
        writtenChunks.push(chunk);
      },
    });

    const model = {
      provider: 'mock-provider',
      modelId: 'mock-model',
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'getWeather',
              input: '{"city":"San Francisco"',
            });
            controller.enqueue({
              type: 'finish',
              finishReason: 'tool-calls',
              usage: {
                inputTokens: { total: 10, noCache: 10 },
                outputTokens: { total: 5, text: 0, reasoning: 5 },
              },
            });
            controller.close();
          },
        }),
      }),
    };

    const result = await doStreamStep(
      [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      async () => model as any,
      writable,
      undefined,
      { sendStart: false }
    );

    expect(result.step.toolCalls).toHaveLength(1);
    expect(result.step.toolCalls[0]?.input).toBe('{"city":"San Francisco"');
    expect(writtenChunks).toContainEqual(
      expect.objectContaining({
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'getWeather',
        input: '{"city":"San Francisco"',
      })
    );
  });
});
