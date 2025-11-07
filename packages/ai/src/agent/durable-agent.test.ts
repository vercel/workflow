/**
 * Tests for DurableAgent
 */
import type { LanguageModelV2 } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { DurableAgent } from './durable-agent.js';

describe('DurableAgent', () => {
  describe('constructor', () => {
    it('should accept a string model', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-3-opus',
        tools: {},
      });
      expect(agent).toBeDefined();
    });

    it('should accept a LanguageModelV2 instance', () => {
      // Create a minimal mock LanguageModelV2 instance
      const mockModel: LanguageModelV2 = {
        specificationVersion: 'v2',
        provider: 'test-provider',
        modelId: 'test-model',
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

      const agent = new DurableAgent({
        model: mockModel,
        tools: {},
      });
      expect(agent).toBeDefined();
    });

    it('should accept tools and system prompt', () => {
      const agent = new DurableAgent({
        model: 'anthropic/claude-3-opus',
        tools: {
          testTool: {
            description: 'A test tool',
            inputSchema: {},
            execute: async () => 'result',
          },
        },
        system: 'You are a helpful assistant',
      });
      expect(agent).toBeDefined();
    });
  });
});
