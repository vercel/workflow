/**
 * Tests for LanguageModelV2 serialization
 */
import type { LanguageModelV2 } from '@ai-sdk/provider';
import * as devalue from 'devalue';
import { describe, expect, it } from 'vitest';
import {
  getExternalReducers,
  getExternalRevivers,
  getWorkflowReducers,
  getWorkflowRevivers,
} from '@workflow/core/serialization';

describe('LanguageModelV2 serialization', () => {
  it('should serialize and deserialize a LanguageModelV2 instance', () => {
    // Create a minimal mock LanguageModelV2 instance
    const mockModel: LanguageModelV2 = {
      specificationVersion: 'v2',
      provider: 'test-provider',
      modelId: 'test-model-id',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [],
        finishReason: 'stop',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        warnings: [],
      }),
      doStream: async () => ({
        stream: new ReadableStream(),
      }),
    };

    // Serialize using workflow reducers
    const serialized = devalue.stringify(mockModel, getWorkflowReducers());
    expect(serialized).toBeDefined();
    expect(serialized).toContain('test-provider');
    expect(serialized).toContain('test-model-id');

    // Deserialize using workflow revivers
    const deserialized = devalue.parse(serialized, getWorkflowRevivers());
    expect(deserialized).toBeDefined();
    expect(deserialized.__languageModelV2).toBe(true);
    expect(deserialized.provider).toBe('test-provider');
    expect(deserialized.modelId).toBe('test-model-id');
  });

  it('should serialize and deserialize through external boundary', () => {
    const ops: Promise<any>[] = [];

    // Create a minimal mock LanguageModelV2 instance
    const mockModel: LanguageModelV2 = {
      specificationVersion: 'v2',
      provider: 'anthropic',
      modelId: 'claude-3-opus',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [],
        finishReason: 'stop',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        warnings: [],
      }),
      doStream: async () => ({
        stream: new ReadableStream(),
      }),
    };

    // Serialize using external reducers
    const serialized = devalue.stringify(
      mockModel,
      getExternalReducers(globalThis, ops)
    );
    expect(serialized).toBeDefined();

    // Deserialize using external revivers
    const deserialized = devalue.parse(
      serialized,
      getExternalRevivers(globalThis, ops)
    );
    expect(deserialized).toBeDefined();
    expect(deserialized.__languageModelV2).toBe(true);
    expect(deserialized.provider).toBe('anthropic');
    expect(deserialized.modelId).toBe('claude-3-opus');
  });

  it('should handle string models without modification', () => {
    const stringModel = 'anthropic/claude-3-opus';
    const ops: Promise<any>[] = [];

    const serialized = devalue.stringify(stringModel, getWorkflowReducers());
    const deserialized = devalue.parse(serialized, getWorkflowRevivers());

    expect(deserialized).toBe(stringModel);
  });
});
