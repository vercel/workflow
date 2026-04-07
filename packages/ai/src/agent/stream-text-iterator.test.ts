/**
 * Tests for streamTextIterator
 *
 * These tests verify that providerMetadata from tool calls is correctly
 * mapped to providerOptions in the conversation prompt, which is critical
 * for providers like Gemini that require thoughtSignature to be preserved
 * across multi-turn tool calls.
 */
import type {
  LanguageModelV3Prompt,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResult,
  LanguageModelV3ToolResultPart,
} from '@ai-sdk/provider';
import type { StepResult, ToolSet, UIMessageChunk } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock doStreamStep
vi.mock('./do-stream-step.js', () => ({
  doStreamStep: vi.fn(),
}));

// Import after mocking
const { streamTextIterator } = await import('./stream-text-iterator.js');
const { doStreamStep } = await import('./do-stream-step.js');

/**
 * Helper to create a mock writable stream
 */
function createMockWritable(): WritableStream<UIMessageChunk> {
  return new WritableStream({
    write: vi.fn(),
    close: vi.fn(),
  });
}

/**
 * Helper to create a minimal step result for testing
 */
function createMockStepResult(
  overrides: Partial<StepResult<ToolSet>> = {}
): StepResult<ToolSet> {
  return {
    content: [],
    text: '',
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: [],
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    warnings: [],
    request: { body: '' },
    response: {
      id: 'test',
      timestamp: new Date(),
      modelId: 'test',
      messages: [],
    },
    providerMetadata: {},
    ...overrides,
  };
}

describe('streamTextIterator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('providerMetadata to providerOptions mapping', () => {
    it('should preserve providerMetadata as providerOptions in tool-call messages', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      // Capture the conversation prompt passed to subsequent doStreamStep calls
      let capturedPrompt: LanguageModelV3Prompt | undefined;

      const toolCallWithMetadata: LanguageModelV3ToolCall = {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{"query":"test"}',
        providerMetadata: {
          google: {
            thoughtSignature: 'sig_abc123_test_signature',
          },
        },
      };

      // First call returns tool-calls with providerMetadata
      // Second call (after tool results) should receive the updated prompt
      vi.mocked(doStreamStep)
        .mockResolvedValueOnce({
          toolCalls: [toolCallWithMetadata],
          finish: { finishReason: 'tool-calls' },
          step: createMockStepResult({ finishReason: 'tool-calls' }),
        })
        .mockImplementationOnce(async (prompt) => {
          // Capture the prompt on the second call to verify providerOptions
          capturedPrompt = prompt;
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        tools: {
          testTool: {
            description: 'A test tool',
            execute: async () => ({ result: 'success' }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
      });

      // First iteration - get tool calls
      const firstResult = await iterator.next();
      expect(firstResult.done).toBe(false);
      expect(firstResult.value.toolCalls).toHaveLength(1);

      // Provide tool results and continue
      const toolResults: LanguageModelV3ToolResult[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'testTool',
          output: { type: 'text', value: '{"result":"success"}' },
        },
      ];

      // Second iteration - should trigger second doStreamStep call
      const secondResult = await iterator.next(toolResults);

      // Verify the captured prompt contains providerOptions
      expect(capturedPrompt).toBeDefined();

      // Find the assistant message with tool calls
      const assistantMessage = capturedPrompt?.find(
        (msg) => msg.role === 'assistant'
      );
      expect(assistantMessage).toBeDefined();

      // Verify the tool-call part has providerOptions mapped from providerMetadata
      const toolCallPart = (assistantMessage?.content as any[])?.find(
        (part) => part.type === 'tool-call'
      );
      expect(toolCallPart).toBeDefined();
      expect(toolCallPart.providerOptions).toEqual({
        google: {
          thoughtSignature: 'sig_abc123_test_signature',
        },
      });
    });

    it('should not add providerOptions when providerMetadata is undefined', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      const toolCallWithoutMetadata: LanguageModelV3ToolCall = {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{"query":"test"}',
        // No providerMetadata
      };

      vi.mocked(doStreamStep)
        .mockResolvedValueOnce({
          toolCalls: [toolCallWithoutMetadata],
          finish: { finishReason: 'tool-calls' },
          step: createMockStepResult({ finishReason: 'tool-calls' }),
        })
        .mockImplementationOnce(async (prompt) => {
          capturedPrompt = prompt;
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        tools: {
          testTool: {
            description: 'A test tool',
            execute: async () => ({ result: 'success' }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
      });

      const firstResult = await iterator.next();
      expect(firstResult.done).toBe(false);

      const toolResults: LanguageModelV3ToolResult[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'testTool',
          output: { type: 'text', value: '{"result":"success"}' },
        },
      ];

      await iterator.next(toolResults);

      const assistantMessage = capturedPrompt?.find(
        (msg) => msg.role === 'assistant'
      );
      const toolCallPart = (assistantMessage?.content as any[])?.find(
        (part) => part.type === 'tool-call'
      );

      expect(toolCallPart).toBeDefined();
      expect(toolCallPart.providerOptions).toBeUndefined();
    });

    it('should preserve providerMetadata for multiple parallel tool calls', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      const toolCalls: LanguageModelV3ToolCall[] = [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'weatherTool',
          input: '{"city":"NYC"}',
          providerMetadata: {
            google: { thoughtSignature: 'sig_weather_123' },
          },
        },
        {
          type: 'tool-call',
          toolCallId: 'call-2',
          toolName: 'newsTool',
          input: '{"topic":"tech"}',
          providerMetadata: {
            google: { thoughtSignature: 'sig_news_456' },
          },
        },
      ];

      vi.mocked(doStreamStep)
        .mockResolvedValueOnce({
          toolCalls,
          finish: { finishReason: 'tool-calls' },
          step: createMockStepResult({ finishReason: 'tool-calls' }),
        })
        .mockImplementationOnce(async (prompt) => {
          capturedPrompt = prompt;
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        tools: {
          weatherTool: {
            description: 'Weather tool',
            execute: async () => ({ temp: 72 }),
          },
          newsTool: {
            description: 'News tool',
            execute: async () => ({ headlines: [] }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
      });

      const firstResult = await iterator.next();
      expect(firstResult.done).toBe(false);
      expect(firstResult.value.toolCalls).toHaveLength(2);

      const toolResults: LanguageModelV3ToolResult[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'weatherTool',
          output: { type: 'text', value: '{"temp":72}' },
        },
        {
          type: 'tool-result',
          toolCallId: 'call-2',
          toolName: 'newsTool',
          output: { type: 'text', value: '{"headlines":[]}' },
        },
      ];

      await iterator.next(toolResults);

      const assistantMessage = capturedPrompt?.find(
        (msg) => msg.role === 'assistant'
      );
      const toolCallParts = (assistantMessage?.content as any[])?.filter(
        (part) => part.type === 'tool-call'
      );

      expect(toolCallParts).toHaveLength(2);

      // Verify each tool call has its own providerOptions
      const weatherToolCall = toolCallParts?.find(
        (part) => part.toolName === 'weatherTool'
      );
      expect(weatherToolCall?.providerOptions).toEqual({
        google: { thoughtSignature: 'sig_weather_123' },
      });

      const newsToolCall = toolCallParts?.find(
        (part) => part.toolName === 'newsTool'
      );
      expect(newsToolCall?.providerOptions).toEqual({
        google: { thoughtSignature: 'sig_news_456' },
      });
    });

    it('should handle mixed tool calls with and without providerMetadata', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      const toolCalls: LanguageModelV3ToolCall[] = [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'toolWithMeta',
          input: '{}',
          providerMetadata: {
            vertex: { thoughtSignature: 'sig_vertex_789' },
          },
        },
        {
          type: 'tool-call',
          toolCallId: 'call-2',
          toolName: 'toolWithoutMeta',
          input: '{}',
          // No providerMetadata
        },
      ];

      vi.mocked(doStreamStep)
        .mockResolvedValueOnce({
          toolCalls,
          finish: { finishReason: 'tool-calls' },
          step: createMockStepResult({ finishReason: 'tool-calls' }),
        })
        .mockImplementationOnce(async (prompt) => {
          capturedPrompt = prompt;
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        tools: {
          toolWithMeta: {
            description: 'Tool with metadata',
            execute: async () => ({ ok: true }),
          },
          toolWithoutMeta: {
            description: 'Tool without metadata',
            execute: async () => ({ ok: true }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
      });

      await iterator.next();

      const toolResults: LanguageModelV3ToolResult[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'toolWithMeta',
          output: { type: 'text', value: '{"ok":true}' },
        },
        {
          type: 'tool-result',
          toolCallId: 'call-2',
          toolName: 'toolWithoutMeta',
          output: { type: 'text', value: '{"ok":true}' },
        },
      ];

      await iterator.next(toolResults);

      const assistantMessage = capturedPrompt?.find(
        (msg) => msg.role === 'assistant'
      );
      const toolCallParts = (assistantMessage?.content as any[])?.filter(
        (part) => part.type === 'tool-call'
      );

      const toolWithMeta = toolCallParts?.find(
        (part) => part.toolName === 'toolWithMeta'
      );
      expect(toolWithMeta?.providerOptions).toEqual({
        vertex: { thoughtSignature: 'sig_vertex_789' },
      });

      const toolWithoutMeta = toolCallParts?.find(
        (part) => part.toolName === 'toolWithoutMeta'
      );
      expect(toolWithoutMeta?.providerOptions).toBeUndefined();
    });

    it('should preserve OpenAI providerMetadata including itemId now that reasoning is preserved', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      // OpenAI Responses API returns itemId which references reasoning items.
      // Now that reasoning is preserved in conversation, itemId is valid.
      const toolCallWithOpenAIMetadata: LanguageModelV3ToolCall = {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{"query":"test"}',
        providerMetadata: {
          openai: {
            itemId: 'fc_0402bf2d292dd7ed00697a35fb10e0819ab0098545c4d0d7f5',
          },
        },
      };

      vi.mocked(doStreamStep)
        .mockResolvedValueOnce({
          toolCalls: [toolCallWithOpenAIMetadata],
          finish: { finishReason: 'tool-calls' },
          step: createMockStepResult({ finishReason: 'tool-calls' }),
        })
        .mockImplementationOnce(async (prompt) => {
          capturedPrompt = prompt;
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        tools: {
          testTool: {
            description: 'A test tool',
            execute: async () => ({ result: 'success' }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
      });

      await iterator.next();

      const toolResults: LanguageModelV3ToolResult[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'testTool',
          output: { type: 'text', value: '{"result":"success"}' },
        },
      ];

      await iterator.next(toolResults);

      const assistantMessage = capturedPrompt?.find(
        (msg) => msg.role === 'assistant'
      );
      const toolCallPart = (assistantMessage?.content as any[])?.find(
        (part) => part.type === 'tool-call'
      );

      // itemId should now be preserved since reasoning items are in the conversation
      expect(toolCallPart).toBeDefined();
      expect(toolCallPart.providerOptions).toEqual({
        openai: {
          itemId: 'fc_0402bf2d292dd7ed00697a35fb10e0819ab0098545c4d0d7f5',
        },
      });
    });

    it('should preserve all OpenAI metadata fields including itemId', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      const toolCallWithMixedOpenAIMetadata: LanguageModelV3ToolCall = {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{"query":"test"}',
        providerMetadata: {
          openai: {
            itemId: 'fc_0402bf2d292dd7ed00697a35fb10e0819ab0098545c4d0d7f5',
            someOtherField: 'should-be-preserved',
          },
        },
      };

      vi.mocked(doStreamStep)
        .mockResolvedValueOnce({
          toolCalls: [toolCallWithMixedOpenAIMetadata],
          finish: { finishReason: 'tool-calls' },
          step: createMockStepResult({ finishReason: 'tool-calls' }),
        })
        .mockImplementationOnce(async (prompt) => {
          capturedPrompt = prompt;
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        tools: {
          testTool: {
            description: 'A test tool',
            execute: async () => ({ result: 'success' }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
      });

      await iterator.next();

      const toolResults: LanguageModelV3ToolResult[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'testTool',
          output: { type: 'text', value: '{"result":"success"}' },
        },
      ];

      await iterator.next(toolResults);

      const assistantMessage = capturedPrompt?.find(
        (msg) => msg.role === 'assistant'
      );
      const toolCallPart = (assistantMessage?.content as any[])?.find(
        (part) => part.type === 'tool-call'
      );

      expect(toolCallPart).toBeDefined();
      expect(toolCallPart.providerOptions).toEqual({
        openai: {
          itemId: 'fc_0402bf2d292dd7ed00697a35fb10e0819ab0098545c4d0d7f5',
          someOtherField: 'should-be-preserved',
        },
      });
    });

    it('should preserve both Gemini and OpenAI metadata in mixed provider metadata', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      const toolCallWithMixedProviders: LanguageModelV3ToolCall = {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{"query":"test"}',
        providerMetadata: {
          google: {
            thoughtSignature: 'sig_gemini_preserved',
          },
          openai: {
            itemId: 'fc_should_also_be_preserved',
          },
        },
      };

      vi.mocked(doStreamStep)
        .mockResolvedValueOnce({
          toolCalls: [toolCallWithMixedProviders],
          finish: { finishReason: 'tool-calls' },
          step: createMockStepResult({ finishReason: 'tool-calls' }),
        })
        .mockImplementationOnce(async (prompt) => {
          capturedPrompt = prompt;
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        tools: {
          testTool: {
            description: 'A test tool',
            execute: async () => ({ result: 'success' }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
      });

      await iterator.next();

      const toolResults: LanguageModelV3ToolResult[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'testTool',
          output: { type: 'text', value: '{"result":"success"}' },
        },
      ];

      await iterator.next(toolResults);

      const assistantMessage = capturedPrompt?.find(
        (msg) => msg.role === 'assistant'
      );
      const toolCallPart = (assistantMessage?.content as any[])?.find(
        (part) => part.type === 'tool-call'
      );

      expect(toolCallPart).toBeDefined();
      expect(toolCallPart.providerOptions).toEqual({
        google: {
          thoughtSignature: 'sig_gemini_preserved',
        },
        openai: {
          itemId: 'fc_should_also_be_preserved',
        },
      });
    });
  });

  describe('reasoning content preservation', () => {
    it('should include reasoning parts in assistant message before tool-call parts', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      const toolCall: LanguageModelV3ToolCall = {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{"query":"test"}',
      };

      vi.mocked(doStreamStep)
        .mockResolvedValueOnce({
          toolCalls: [toolCall],
          finish: { finishReason: 'tool-calls' },
          step: createMockStepResult({
            finishReason: 'tool-calls',
            reasoning: [
              { type: 'reasoning', text: 'Let me think about this...' },
              { type: 'reasoning', text: 'I should use the test tool.' },
            ],
          }),
        })
        .mockImplementationOnce(async (prompt) => {
          capturedPrompt = prompt;
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        tools: {
          testTool: {
            description: 'A test tool',
            execute: async () => ({ result: 'success' }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
      });

      await iterator.next();

      const toolResults: LanguageModelV3ToolResult[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'testTool',
          output: { type: 'text', value: '{"result":"success"}' },
        },
      ];

      await iterator.next(toolResults);

      const assistantMessage = capturedPrompt?.find(
        (msg) => msg.role === 'assistant'
      );
      const content = assistantMessage?.content as any[];

      // Reasoning parts should come before tool-call parts
      expect(content).toHaveLength(3);
      expect(content[0]).toEqual({
        type: 'reasoning',
        text: 'Let me think about this...',
      });
      expect(content[1]).toEqual({
        type: 'reasoning',
        text: 'I should use the test tool.',
      });
      expect(content[2].type).toBe('tool-call');
      expect(content[2].toolCallId).toBe('call-1');
    });

    it('should preserve reasoning providerOptions', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      const toolCall: LanguageModelV3ToolCall = {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{}',
      };

      vi.mocked(doStreamStep)
        .mockResolvedValueOnce({
          toolCalls: [toolCall],
          finish: { finishReason: 'tool-calls' },
          step: createMockStepResult({
            finishReason: 'tool-calls',
            reasoning: [
              {
                type: 'reasoning',
                text: 'thinking...',
                providerOptions: {
                  anthropic: { cacheControl: { type: 'ephemeral' } },
                },
              },
            ],
          }),
        })
        .mockImplementationOnce(async (prompt) => {
          capturedPrompt = prompt;
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        tools: {
          testTool: {
            description: 'A test tool',
            execute: async () => ({ ok: true }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
      });

      await iterator.next();

      const toolResults: LanguageModelV3ToolResult[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'testTool',
          output: { type: 'text', value: '{"ok":true}' },
        },
      ];

      await iterator.next(toolResults);

      const assistantMessage = capturedPrompt?.find(
        (msg) => msg.role === 'assistant'
      );
      const reasoningPart = (assistantMessage?.content as any[])?.[0];

      expect(reasoningPart).toEqual({
        type: 'reasoning',
        text: 'thinking...',
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral' } },
        },
      });
    });

    it('should not add reasoning parts when step has no reasoning', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      const toolCall: LanguageModelV3ToolCall = {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{}',
      };

      vi.mocked(doStreamStep)
        .mockResolvedValueOnce({
          toolCalls: [toolCall],
          finish: { finishReason: 'tool-calls' },
          step: createMockStepResult({
            finishReason: 'tool-calls',
            reasoning: [],
          }),
        })
        .mockImplementationOnce(async (prompt) => {
          capturedPrompt = prompt;
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        tools: {
          testTool: {
            description: 'A test tool',
            execute: async () => ({ ok: true }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
      });

      await iterator.next();

      const toolResults: LanguageModelV3ToolResult[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'testTool',
          output: { type: 'text', value: '{"ok":true}' },
        },
      ];

      await iterator.next(toolResults);

      const assistantMessage = capturedPrompt?.find(
        (msg) => msg.role === 'assistant'
      );
      const content = assistantMessage?.content as any[];

      // Only tool-call parts, no reasoning
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('tool-call');
    });
  });

  describe('prepareStep system and messages ordering', () => {
    it('should apply system message when prepareStep returns only system', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      vi.mocked(doStreamStep).mockImplementationOnce(async (prompt) => {
        capturedPrompt = prompt;
        return {
          toolCalls: [],
          finish: { finishReason: 'stop' },
          step: createMockStepResult({ finishReason: 'stop' }),
        };
      });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: {} as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
        prepareStep: () => ({
          system: 'You are a helpful assistant.',
        }),
      });

      await iterator.next();

      expect(capturedPrompt).toBeDefined();
      expect(capturedPrompt![0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
      });
      expect(capturedPrompt![1]).toEqual({
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      });
    });

    it('should preserve system message when prepareStep returns both system and messages', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      vi.mocked(doStreamStep).mockImplementationOnce(async (prompt) => {
        capturedPrompt = prompt;
        return {
          toolCalls: [],
          finish: { finishReason: 'stop' },
          step: createMockStepResult({ finishReason: 'stop' }),
        };
      });

      // prepareStep returns both system and messages — system should NOT be lost
      const customMessages: LanguageModelV3Prompt = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'modified message' }],
        },
      ];

      const iterator = streamTextIterator({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'original' }] },
        ],
        tools: {} as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
        prepareStep: () => ({
          system: 'Dynamic system prompt.',
          messages: customMessages,
        }),
      });

      await iterator.next();

      expect(capturedPrompt).toBeDefined();
      // System message should be prepended to the replaced messages
      expect(capturedPrompt!).toHaveLength(2);
      expect(capturedPrompt![0]).toEqual({
        role: 'system',
        content: 'Dynamic system prompt.',
      });
      expect(capturedPrompt![1]).toEqual({
        role: 'user',
        content: [{ type: 'text', text: 'modified message' }],
      });
    });

    it('should replace existing system message when messages already contains one', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      let capturedPrompt: LanguageModelV3Prompt | undefined;

      vi.mocked(doStreamStep).mockImplementationOnce(async (prompt) => {
        capturedPrompt = prompt;
        return {
          toolCalls: [],
          finish: { finishReason: 'stop' },
          step: createMockStepResult({ finishReason: 'stop' }),
        };
      });

      // Messages already include a system message — prepareStep's system should replace it
      const customMessages: LanguageModelV3Prompt = [
        { role: 'system', content: 'Old system prompt.' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ];

      const iterator = streamTextIterator({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'original' }] },
        ],
        tools: {} as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
        prepareStep: () => ({
          system: 'New system prompt.',
          messages: customMessages,
        }),
      });

      await iterator.next();

      expect(capturedPrompt).toBeDefined();
      expect(capturedPrompt!).toHaveLength(2);
      expect(capturedPrompt![0]).toEqual({
        role: 'system',
        content: 'New system prompt.',
      });
      expect(capturedPrompt![1]).toEqual({
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      });
    });

    it('should update system message on subsequent steps', async () => {
      const mockWritable = createMockWritable();
      const mockModel = vi.fn();

      const capturedPrompts: LanguageModelV3Prompt[] = [];

      const toolCall: LanguageModelV3ToolCall = {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{}',
      };

      vi.mocked(doStreamStep)
        .mockImplementationOnce(async (prompt) => {
          capturedPrompts.push([...prompt]);
          return {
            toolCalls: [toolCall],
            finish: { finishReason: 'tool-calls' },
            step: createMockStepResult({ finishReason: 'tool-calls' }),
          };
        })
        .mockImplementationOnce(async (prompt) => {
          capturedPrompts.push([...prompt]);
          return {
            toolCalls: [],
            finish: { finishReason: 'stop' },
            step: createMockStepResult({ finishReason: 'stop' }),
          };
        });

      const iterator = streamTextIterator({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: {
          testTool: {
            description: 'Test',
            execute: async () => ({ ok: true }),
          },
        } as ToolSet,
        writable: mockWritable,
        model: mockModel as any,
        prepareStep: ({ stepNumber: sn }) => ({
          system: `System prompt v${sn}`,
        }),
      });

      // First step
      await iterator.next();

      // Provide tool results
      const toolResults: LanguageModelV3ToolResultPart[] = [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'testTool',
          output: { type: 'text', value: '{"ok":true}' },
        },
      ];

      // Second step
      await iterator.next(toolResults);

      expect(capturedPrompts).toHaveLength(2);
      // First step should have system v0
      expect(capturedPrompts[0][0]).toEqual({
        role: 'system',
        content: 'System prompt v0',
      });
      // Second step should have system v1
      expect(capturedPrompts[1][0]).toEqual({
        role: 'system',
        content: 'System prompt v1',
      });
    });
  });
});
