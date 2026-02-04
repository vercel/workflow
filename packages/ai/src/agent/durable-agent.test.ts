/**
 * Tests for DurableAgent
 *
 * These tests focus on error handling in tool execution,
 * particularly for FatalError conversion to tool result errors,
 * and verifying that messages are properly passed to tool execute functions.
 */
import type {
  LanguageModelV2,
  LanguageModelV2Prompt,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from '@ai-sdk/provider';
import type { StepResult, ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { FatalError } from 'workflow';
import { z } from 'zod';

// Mock the streamTextIterator
vi.mock('./stream-text-iterator.js', () => ({
  streamTextIterator: vi.fn(),
}));

// Import after mocking
const { DurableAgent } = await import('./durable-agent.js');

import type {
  PrepareStepCallback,
  ToolCallRepairFunction,
} from './durable-agent.js';
import type { StreamTextIteratorYieldValue } from './stream-text-iterator.js';

/** Default string model ID for tests (streamTextIterator is mocked, so the value is opaque). */
const TEST_MODEL = 'test/test-model';

/**
 * Creates a mock LanguageModelV2 for tests that specifically need model objects.
 */
function createMockModel(): LanguageModelV2 {
  return {
    specificationVersion: 'v2' as const,
    provider: 'test',
    modelId: 'test-model',
    doGenerate: vi.fn(),
    doStream: vi.fn(),
    supportedUrls: {},
  };
}

/**
 * Type for the mock iterator used in tests
 */
type MockIterator = AsyncGenerator<
  StreamTextIteratorYieldValue,
  LanguageModelV2Prompt,
  LanguageModelV2ToolResultPart[]
>;

describe('DurableAgent', () => {
  describe('tool execution error handling', () => {
    it('should convert FatalError to tool error result', async () => {
      const errorMessage = 'This is a fatal error';
      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({}),
          execute: async () => {
            throw new FatalError(errorMessage);
          },
        },
      };

      // We need to test the executeTool function indirectly through the agent
      // Create a mock model that will trigger tool calls
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      // Create a mock writable stream
      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      // Mock the streamTextIterator to return tool calls and then complete
      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: '{}',
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      // Execute the stream - this should not throw even though the tool throws FatalError
      await expect(
        agent.stream({
          messages: [{ role: 'user', content: 'test' }],
          writable: mockWritable,
        })
      ).resolves.not.toThrow();

      // Verify that the iterator was called with tool results including the error
      expect(mockIterator.next).toHaveBeenCalledTimes(2);
      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall).toBeDefined();
      expect(toolResultsCall).toHaveLength(1);
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'test-call-id',
        toolName: 'testTool',
        output: {
          type: 'error-text',
          value: errorMessage,
        },
      });
    });

    it('should re-throw non-FatalError errors for retry', async () => {
      const errorMessage = 'This is a retryable error';
      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({}),
          execute: async () => {
            throw new Error(errorMessage);
          },
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({
          done: false,
          value: {
            toolCalls: [
              {
                toolCallId: 'test-call-id',
                toolName: 'testTool',
                input: '{}',
              } as LanguageModelV2ToolCall,
            ],
            messages: mockMessages,
          },
        }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      // Execute should throw because non-FatalErrors are re-thrown
      await expect(
        agent.stream({
          messages: [{ role: 'user', content: 'test' }],
          writable: mockWritable,
        })
      ).rejects.toThrow(errorMessage);
    });

    it('should successfully execute tools that return normally', async () => {
      const toolResult = { success: true, data: 'test result' };
      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({}),
          execute: async () => toolResult,
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: '{}',
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // Verify that the iterator was called with successful tool results
      expect(mockIterator.next).toHaveBeenCalledTimes(2);
      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall).toBeDefined();
      expect(toolResultsCall).toHaveLength(1);
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'test-call-id',
        toolName: 'testTool',
        output: {
          // Object results use 'json' type with raw value (not stringified)
          type: 'json',
          value: toolResult,
        },
      });
    });

    it('should skip local execution for provider-executed tools', async () => {
      // This tool should NOT be called because the tool call is provider-executed
      const executeFn = vi.fn();
      const tools: ToolSet = {
        // This is a local tool - should never be called for provider-executed calls
        localTool: {
          description: 'A local tool',
          inputSchema: z.object({}),
          execute: executeFn,
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];

      // Create a provider-executed tool result map
      const providerExecutedToolResults = new Map();
      providerExecutedToolResults.set('provider-call-id', {
        toolCallId: 'provider-call-id',
        toolName: 'WebSearch',
        result: 'Search results for: test query',
        isError: false,
      });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'provider-call-id',
                  toolName: 'WebSearch',
                  input: '{"query":"test query"}',
                  providerExecuted: true, // This is a provider-executed tool
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
              providerExecutedToolResults,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // The local tool execute function should NOT have been called
      expect(executeFn).not.toHaveBeenCalled();

      // Verify that the iterator was called with the provider-executed tool result
      expect(mockIterator.next).toHaveBeenCalledTimes(2);
      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall).toBeDefined();
      expect(toolResultsCall).toHaveLength(1);
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'provider-call-id',
        toolName: 'WebSearch',
        output: {
          // String results use 'text' type with raw value
          type: 'text',
          value: 'Search results for: test query',
        },
      });
    });

    it('should handle mixed provider-executed and local tools', async () => {
      const localToolResult = { local: 'result' };
      const localExecuteFn = vi.fn().mockResolvedValue(localToolResult);
      const tools: ToolSet = {
        localTool: {
          description: 'A local tool',
          inputSchema: z.object({}),
          execute: localExecuteFn,
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];

      // Create a provider-executed tool result map
      const providerExecutedToolResults = new Map();
      providerExecutedToolResults.set('provider-call-id', {
        toolCallId: 'provider-call-id',
        toolName: 'WebSearch',
        result: { searchResults: ['result1', 'result2'] },
        isError: false,
      });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                // Local tool call - should be executed locally
                {
                  toolCallId: 'local-call-id',
                  toolName: 'localTool',
                  input: '{}',
                  providerExecuted: false,
                } as LanguageModelV2ToolCall,
                // Provider-executed tool call - should use stream result
                {
                  toolCallId: 'provider-call-id',
                  toolName: 'WebSearch',
                  input: '{"query":"test"}',
                  providerExecuted: true,
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
              providerExecutedToolResults,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // The local tool execute function SHOULD have been called
      expect(localExecuteFn).toHaveBeenCalledTimes(1);

      // Verify that the iterator was called with both tool results
      expect(mockIterator.next).toHaveBeenCalledTimes(2);
      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall).toBeDefined();
      expect(toolResultsCall).toHaveLength(2);

      // First result should be from local tool (object result uses 'json' type)
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'local-call-id',
        toolName: 'localTool',
        output: {
          type: 'json',
          value: localToolResult,
        },
      });

      // Second result should be from provider-executed tool (object result uses 'json' type)
      expect(toolResultsCall[1]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'provider-call-id',
        toolName: 'WebSearch',
        output: {
          type: 'json',
          value: { searchResults: ['result1', 'result2'] },
        },
      });
    });

    it('should handle provider-executed tool errors with isError flag', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];

      // Create a provider-executed tool result with isError: true
      const providerExecutedToolResults = new Map();
      providerExecutedToolResults.set('provider-call-id', {
        toolCallId: 'provider-call-id',
        toolName: 'WebSearch',
        result: 'Search failed: Rate limit exceeded',
        isError: true,
      });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'provider-call-id',
                  toolName: 'WebSearch',
                  input: '{"query":"test query"}',
                  providerExecuted: true,
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
              providerExecutedToolResults,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // Verify that the iterator was called with error-text output type
      expect(mockIterator.next).toHaveBeenCalledTimes(2);
      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall).toBeDefined();
      expect(toolResultsCall).toHaveLength(1);
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'provider-call-id',
        toolName: 'WebSearch',
        output: {
          // String error results use 'error-text' type with raw value
          type: 'error-text',
          value: 'Search failed: Rate limit exceeded',
        },
      });
    });

    it('should warn and return empty result when provider-executed tool result is missing', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];

      // Empty map - no provider results available
      const providerExecutedToolResults = new Map();

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'missing-result-id',
                  toolName: 'WebSearch',
                  input: '{"query":"test query"}',
                  providerExecuted: true,
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
              providerExecutedToolResults,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // Verify warning was logged
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Provider-executed tool "WebSearch"')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('missing-result-id')
      );

      // Verify empty result was returned
      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall).toBeDefined();
      expect(toolResultsCall).toHaveLength(1);
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'missing-result-id',
        toolName: 'WebSearch',
        output: {
          type: 'text',
          value: '',
        },
      });

      consoleWarnSpy.mockRestore();
    });
  });

  describe('prepareStep callback', () => {
    it('should pass prepareStep callback to streamTextIterator', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const prepareStep: PrepareStepCallback = vi.fn().mockReturnValue({});

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        prepareStep,
      });

      // Verify streamTextIterator was called with prepareStep
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          prepareStep,
        })
      );
    });

    it('should allow prepareStep to modify messages', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const injectedMessage = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'injected message' }],
      };

      const prepareStep: PrepareStepCallback = ({ messages }) => {
        return {
          messages: [...messages, injectedMessage],
        };
      };

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        prepareStep,
      });

      // Verify prepareStep was passed to the iterator
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          prepareStep: expect.any(Function),
        })
      );
    });

    it('should allow prepareStep to change model dynamically', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const prepareStep: PrepareStepCallback = ({ stepNumber }) => {
        // Switch to a different model after step 0
        if (stepNumber > 0) {
          return {
            model: 'anthropic/claude-sonnet-4.5',
          };
        }
        return {};
      };

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        prepareStep,
      });

      // Verify prepareStep was passed to the iterator
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          prepareStep: expect.any(Function),
        })
      );
    });

    it('should provide step information to prepareStep callback', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const prepareStepCalls: Array<{
        model: unknown;
        stepNumber: number;
        steps: unknown[];
        messages: LanguageModelV2Prompt;
      }> = [];

      const prepareStep: PrepareStepCallback = (info) => {
        prepareStepCalls.push({
          model: info.model,
          stepNumber: info.stepNumber,
          steps: info.steps,
          messages: info.messages,
        });
        return {};
      };

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        prepareStep,
      });

      // Verify prepareStep was passed and the function captures expected params
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          prepareStep: expect.any(Function),
        })
      );
    });
  });

  describe('tool execution with messages', () => {
    it('should pass conversation messages to tool execute function', async () => {
      // Track what messages were passed to the tool
      let receivedMessages: unknown;
      let receivedToolCallId: string | undefined;

      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({ query: z.string() }),
          execute: async (_input, options) => {
            receivedMessages = options.messages;
            receivedToolCallId = options.toolCallId;
            return { result: 'success' };
          },
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      // Mock conversation messages that would be accumulated by the iterator
      const conversationMessages: LanguageModelV2Prompt = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'What is the weather?' }],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'test-call-id',
              toolName: 'testTool',
              input: { query: 'weather' },
            },
          ],
        },
      ];

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: '{"query":"weather"}',
                } as LanguageModelV2ToolCall,
              ],
              messages: conversationMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'What is the weather?' }],
        writable: mockWritable,
      });

      // Verify that messages were passed to the tool
      expect(receivedToolCallId).toBe('test-call-id');
      expect(receivedMessages).toBeDefined();
      expect(Array.isArray(receivedMessages)).toBe(true);
      expect(receivedMessages).toEqual(conversationMessages);
    });

    it('should pass messages to multiple tools in parallel execution', async () => {
      // Track messages received by each tool
      const receivedByTools: Record<string, unknown> = {};

      const tools: ToolSet = {
        weatherTool: {
          description: 'Get weather',
          inputSchema: z.object({ city: z.string() }),
          execute: async (_input, options) => {
            receivedByTools['weatherTool'] = options.messages;
            return { temp: 72 };
          },
        },
        newsTool: {
          description: 'Get news',
          inputSchema: z.object({ topic: z.string() }),
          execute: async (_input, options) => {
            receivedByTools['newsTool'] = options.messages;
            return { headlines: ['News 1'] };
          },
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const conversationMessages: LanguageModelV2Prompt = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Weather and news please' }],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'weather-call',
              toolName: 'weatherTool',
              input: { city: 'NYC' },
            },
            {
              type: 'tool-call',
              toolCallId: 'news-call',
              toolName: 'newsTool',
              input: { topic: 'tech' },
            },
          ],
        },
      ];

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'weather-call',
                  toolName: 'weatherTool',
                  input: '{"city":"NYC"}',
                } as LanguageModelV2ToolCall,
                {
                  toolCallId: 'news-call',
                  toolName: 'newsTool',
                  input: '{"topic":"tech"}',
                } as LanguageModelV2ToolCall,
              ],
              messages: conversationMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'Weather and news please' }],
        writable: mockWritable,
      });

      // Both tools should have received the same conversation messages
      expect(receivedByTools['weatherTool']).toEqual(conversationMessages);
      expect(receivedByTools['newsTool']).toEqual(conversationMessages);
    });

    it('should pass updated messages on subsequent tool call rounds', async () => {
      // Track messages received in each round
      const messagesPerRound: unknown[] = [];

      const tools: ToolSet = {
        searchTool: {
          description: 'Search for info',
          inputSchema: z.object({ query: z.string() }),
          execute: async (_input, options) => {
            messagesPerRound.push(options.messages);
            return { found: true };
          },
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      // First round messages
      const firstRoundMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'Search for cats' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'search-1',
              toolName: 'searchTool',
              input: { query: 'cats' },
            },
          ],
        },
      ];

      // Second round messages (includes first tool result)
      const secondRoundMessages: LanguageModelV2Prompt = [
        ...firstRoundMessages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'search-1',
              toolName: 'searchTool',
              output: { type: 'text', value: '{"found":true}' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'search-2',
              toolName: 'searchTool',
              input: { query: 'dogs' },
            },
          ],
        },
      ];

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi
          .fn()
          // First tool call round
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'search-1',
                  toolName: 'searchTool',
                  input: '{"query":"cats"}',
                } as LanguageModelV2ToolCall,
              ],
              messages: firstRoundMessages,
            },
          })
          // Second tool call round
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'search-2',
                  toolName: 'searchTool',
                  input: '{"query":"dogs"}',
                } as LanguageModelV2ToolCall,
              ],
              messages: secondRoundMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'Search for cats' }],
        writable: mockWritable,
      });

      // Verify messages grow with each round
      expect(messagesPerRound).toHaveLength(2);
      expect(messagesPerRound[0]).toEqual(firstRoundMessages);
      expect(messagesPerRound[1]).toEqual(secondRoundMessages);
      // Second round should have more messages than first
      expect((messagesPerRound[1] as unknown[]).length).toBeGreaterThan(
        (messagesPerRound[0] as unknown[]).length
      );
    });
  });

  describe('generation settings', () => {
    it('should pass generation settings from constructor to streamTextIterator', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
        temperature: 0.7,
        maxOutputTokens: 1000,
        topP: 0.9,
        seed: 42,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          generationSettings: expect.objectContaining({
            temperature: 0.7,
            maxOutputTokens: 1000,
            topP: 0.9,
            seed: 42,
          }),
        })
      );
    });

    it('should allow stream options to override constructor generation settings', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
        temperature: 0.7,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        temperature: 0.3, // Override
        maxOutputTokens: 500, // New setting
      });

      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          generationSettings: expect.objectContaining({
            temperature: 0.3,
            maxOutputTokens: 500,
          }),
        })
      );
    });
  });

  describe('maxSteps', () => {
    it('should pass maxSteps to streamTextIterator', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        maxSteps: 5,
      });

      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          maxSteps: 5,
        })
      );
    });
  });

  describe('toolChoice', () => {
    it('should pass toolChoice from constructor to streamTextIterator', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
        toolChoice: 'required',
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: 'required',
        })
      );
    });

    it('should allow stream options to override constructor toolChoice', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
        toolChoice: 'auto',
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        toolChoice: 'none',
      });

      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: 'none',
        })
      );
    });
  });

  describe('activeTools', () => {
    it('should filter tools when activeTools is specified', async () => {
      const tools: ToolSet = {
        tool1: {
          description: 'Tool 1',
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        tool2: {
          description: 'Tool 2',
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        tool3: {
          description: 'Tool 3',
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      // Clear previous mock calls
      vi.mocked(streamTextIterator).mockClear();

      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        activeTools: ['tool1', 'tool3'],
      });

      // Verify only active tools are passed (get the most recent call)
      const calls = vi.mocked(streamTextIterator).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(Object.keys(lastCall.tools).sort()).toEqual(['tool1', 'tool3']);
    });
  });

  describe('callbacks', () => {
    it('should pass onError callback to streamTextIterator', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const onError = vi.fn();

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        onError,
      });

      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          onError,
        })
      );
    });

    it('should call onError when tool execution fails', async () => {
      const toolError = new Error('Tool execution failed');
      const tools: ToolSet = {
        failingTool: {
          description: 'A tool that fails',
          inputSchema: z.object({}),
          execute: async () => {
            throw toolError;
          },
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'failingTool',
                  input: '{}',
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const onError = vi.fn();

      await expect(
        agent.stream({
          messages: [{ role: 'user', content: 'test' }],
          writable: mockWritable,
          onError,
        })
      ).rejects.toThrow('Tool execution failed');

      expect(onError).toHaveBeenCalledWith({ error: toolError });
    });

    it('should call onFinish with steps and messages when streaming completes', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockStep: StepResult<ToolSet> = {
        content: [{ type: 'text', text: 'Hello' }],
        text: 'Hello',
        reasoningText: undefined,
        reasoning: [],
        files: [],
        sources: [],
        toolCalls: [],
        toolResults: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        request: {},
        response: {
          id: 'test-id',
          modelId: 'test-model',
          timestamp: new Date(),
        },
        warnings: [],
        // We're missing some properties that aren't relevant for the test
      } as unknown as StepResult<ToolSet>;
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [],
              messages: mockMessages,
              step: mockStep,
            },
          })
          .mockResolvedValueOnce({ done: true, value: mockMessages }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const onFinish = vi.fn();

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        onFinish,
      });

      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({
          steps: expect.any(Array),
          messages: expect.any(Array),
          experimental_context: undefined,
        })
      );
    });

    it('should call onAbort when abort signal is already aborted', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const onAbort = vi.fn();
      const abortController = new AbortController();
      abortController.abort();

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        abortSignal: abortController.signal,
        onAbort,
      });

      expect(onAbort).toHaveBeenCalledWith({ steps: [] });
    });
  });

  describe('experimental_context', () => {
    it('should pass experimental_context to tool execute function', async () => {
      let receivedContext: unknown;

      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({}),
          execute: async (_input, options) => {
            receivedContext = options.experimental_context;
            return { result: 'success' };
          },
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: '{}',
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
              context: { userId: '123', sessionId: 'abc' },
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        experimental_context: { userId: '123', sessionId: 'abc' },
      });

      expect(receivedContext).toEqual({ userId: '123', sessionId: 'abc' });
    });
  });

  describe('stream result', () => {
    it('should return messages and steps in result', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const mockStep: StepResult<ToolSet> = {
        content: [{ type: 'text', text: 'Hello' }],
        text: 'Hello',
        reasoningText: undefined,
        reasoning: [],
        files: [],
        sources: [],
        toolCalls: [],
        toolResults: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        request: {},
        response: {
          id: 'test-id',
          modelId: 'test-model',
          timestamp: new Date(),
        },
        warnings: [],
        // We're missing some properties that aren't relevant for the test
      } as unknown as StepResult<ToolSet>;
      const finalMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      ];

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [],
              messages: finalMessages,
              step: mockStep,
            },
          })
          .mockResolvedValueOnce({ done: true, value: finalMessages }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const result = await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      expect(result.messages).toBeDefined();
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toEqual(mockStep);
    });
  });

  describe('tool call repair', () => {
    it('should use repair function when tool call fails to parse', async () => {
      const repairFn: ToolCallRepairFunction<ToolSet> = vi
        .fn()
        .mockReturnValue({
          toolCallId: 'test-call-id',
          toolName: 'testTool',
          input: '{"name":"repaired"}', // Fixed input with valid schema
        });

      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({ name: z.string() }),
          execute: async () => ({ result: 'success' }),
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: 'invalid json', // This will fail to parse
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        experimental_repairToolCall: repairFn,
      });

      // Verify repair function was called
      expect(repairFn).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCall: expect.objectContaining({
            toolCallId: 'test-call-id',
            toolName: 'testTool',
          }),
          tools,
          error: expect.any(Error),
          messages: mockMessages,
        })
      );
    });
  });

  describe('includeRawChunks', () => {
    it('should pass includeRawChunks to streamTextIterator', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        includeRawChunks: true,
      });

      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          includeRawChunks: true,
        })
      );
    });
  });

  describe('experimental_telemetry', () => {
    it('should pass telemetry settings from constructor to streamTextIterator', async () => {
      const telemetrySettings = {
        isEnabled: true,
        functionId: 'test-agent',
        metadata: { version: '1.0' },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
        experimental_telemetry: telemetrySettings,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          experimental_telemetry: telemetrySettings,
        })
      );
    });

    it('should allow stream options to override constructor telemetry', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
        experimental_telemetry: { functionId: 'constructor-id' },
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const streamTelemetry = { functionId: 'stream-id', isEnabled: false };

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        experimental_telemetry: streamTelemetry,
      });

      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          experimental_telemetry: streamTelemetry,
        })
      );
    });
  });

  describe('model object acceptance', () => {
    it('should convert V2 model object to string and warn', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const mockModel: LanguageModelV2 = {
        specificationVersion: 'v2' as const,
        provider: 'test',
        modelId: 'test-model',
        doGenerate: vi.fn(),
        doStream: vi.fn(),
        supportedUrls: {},
      };

      const agent = new DurableAgent({
        model: mockModel,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // Verify model was converted to string
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test/test-model',
        })
      );

      // Verify informational warning was emitted
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Model object "test/test-model" was converted to a string'
        )
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('V3 model object', () => {
    it('should convert V3 model object to string', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      // V3 models only need identity properties — doStream is not required
      // because resolveModelId converts model objects to strings
      const v3Model = {
        specificationVersion: 'v3' as const,
        provider: 'anthropic',
        modelId: 'claude-opus',
      };

      const agent = new DurableAgent({
        model: v3Model,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // Verify model was converted to string
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'anthropic/claude-opus',
        })
      );

      consoleWarnSpy.mockRestore();
    });

    it('should produce compound string when provider already contains a slash', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const v2Model: LanguageModelV2 = {
        specificationVersion: 'v2' as const,
        provider: 'my-org/anthropic',
        modelId: 'claude-opus',
        doGenerate: vi.fn(),
        doStream: vi.fn(),
        supportedUrls: {},
      };

      const agent = new DurableAgent({
        model: v2Model,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // The compound string includes both slashes — callers should be
      // aware that provider names containing '/' produce multi-segment IDs
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'my-org/anthropic/claude-opus',
        })
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('factory function deprecation', () => {
    it('should emit deprecation warning for factory function model', () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const mockModel = createMockModel();

      new DurableAgent({
        model: async () => mockModel,
        tools: {},
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Factory function model is deprecated')
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('instructions alias', () => {
    it('should set system from instructions in constructor', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const agent = new DurableAgent({
        model: 'test/test-model',
        tools: {},
        instructions: 'You are a helpful assistant.',
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // The system prompt should include the instructions text
      // We verify this by checking the prompt passed to streamTextIterator
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: 'You are a helpful assistant.',
            }),
          ]),
        })
      );

      consoleWarnSpy.mockRestore();
    });

    it('should prefer instructions over system when both provided', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const agent = new DurableAgent({
        model: 'test/test-model',
        tools: {},
        system: 'system prompt',
        instructions: 'instructions prompt',
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // instructions takes precedence over system
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: 'instructions prompt',
            }),
          ]),
        })
      );

      consoleWarnSpy.mockRestore();
    });

    it('should allow stream options.instructions to override constructor system', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const agent = new DurableAgent({
        model: 'test/test-model',
        tools: {},
        system: 'constructor system',
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        instructions: 'stream instructions',
      });

      // stream instructions should override constructor system
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: 'stream instructions',
            }),
          ]),
        })
      );

      consoleWarnSpy.mockRestore();
    });

    it('should allow stream options.instructions to override constructor instructions', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const agent = new DurableAgent({
        model: 'test/test-model',
        tools: {},
        instructions: 'constructor instructions',
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        instructions: 'stream instructions',
      });

      // stream instructions should override constructor instructions
      expect(streamTextIterator).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: 'stream instructions',
            }),
          ]),
        })
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('tool result passthrough', () => {
    it('should pass through typed ToolResultOutput without re-wrapping', async () => {
      const contentResult = {
        type: 'content' as const,
        value: [{ type: 'text', text: 'hello' }],
      };
      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({}),
          execute: async () => contentResult,
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: '{}',
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // Verify the typed result was passed through without being wrapped in {type:'json'}
      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'test-call-id',
        toolName: 'testTool',
        output: contentResult,
      });
    });

    it('should still wrap plain objects as json', async () => {
      const plainResult = { data: 'some value' };
      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({}),
          execute: async () => plainResult,
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: '{}',
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // Plain objects should be wrapped with {type:'json'}
      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        output: {
          type: 'json',
          value: plainResult,
        },
      });
    });

    it('should still wrap strings as text', async () => {
      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({}),
          execute: async () => 'hello world',
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: '{}',
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      // String results should be wrapped with {type:'text'}
      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        output: {
          type: 'text',
          value: 'hello world',
        },
      });
    });

    it('should pass through error-text ToolResultOutput without re-wrapping', async () => {
      const errorTextResult = {
        type: 'error-text' as const,
        value: 'Something went wrong',
      };
      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({}),
          execute: async () => errorTextResult,
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: '{}',
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'test-call-id',
        toolName: 'testTool',
        output: errorTextResult,
      });
    });

    it('should pass through error-json ToolResultOutput without re-wrapping', async () => {
      const errorJsonResult = {
        type: 'error-json' as const,
        value: { code: 404, message: 'Not found' },
      };
      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({}),
          execute: async () => errorJsonResult,
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: '{}',
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'test-call-id',
        toolName: 'testTool',
        output: errorJsonResult,
      });
    });

    it('should pass through execution-denied ToolResultOutput without re-wrapping', async () => {
      const deniedResult = {
        type: 'execution-denied' as const,
        reason: 'User denied tool execution',
      };
      const tools: ToolSet = {
        testTool: {
          description: 'A test tool',
          inputSchema: z.object({}),
          execute: async () => deniedResult,
        },
      };

      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockMessages: LanguageModelV2Prompt = [
        { role: 'user', content: [{ type: 'text', text: 'test' }] },
      ];
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              toolCalls: [
                {
                  toolCallId: 'test-call-id',
                  toolName: 'testTool',
                  input: '{}',
                } as LanguageModelV2ToolCall,
              ],
              messages: mockMessages,
            },
          })
          .mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      const toolResultsCall = mockIterator.next.mock.calls[1][0];
      expect(toolResultsCall[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'test-call-id',
        toolName: 'testTool',
        output: deniedResult,
      });
    });
  });

  describe('collectUIMessages', () => {
    it('should return undefined uiMessages when collectUIMessages is false', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const result = await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        collectUIMessages: false,
      });

      expect(result.uiMessages).toBeUndefined();
    });

    it('should return undefined uiMessages when collectUIMessages is not set', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const result = await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
      });

      expect(result.uiMessages).toBeUndefined();
    });

    it('should pass collectUIChunks to streamTextIterator when collectUIMessages is true', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      let capturedCollectUIChunks: boolean | undefined;
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockImplementation((opts) => {
        capturedCollectUIChunks = opts.collectUIChunks;
        return mockIterator as unknown as MockIterator;
      });

      const result = await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        collectUIMessages: true,
      });

      // When collectUIMessages is true, collectUIChunks should be passed to streamTextIterator
      expect(capturedCollectUIChunks).toBe(true);

      // uiMessages should be defined (even if empty, since we're mocking)
      expect(result.uiMessages).toBeDefined();
      expect(Array.isArray(result.uiMessages)).toBe(true);
    });

    it('should work correctly when collectUIMessages is true and sendFinish is false', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const writtenChunks: unknown[] = [];
      const closeFn = vi.fn();
      const mockWritable = new WritableStream({
        write: (chunk) => {
          writtenChunks.push(chunk);
        },
        close: closeFn,
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const result = await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        collectUIMessages: true,
        sendFinish: false,
      });

      // uiMessages should still be defined even when sendFinish is false
      expect(result.uiMessages).toBeDefined();
      expect(Array.isArray(result.uiMessages)).toBe(true);

      // The original writable should have been closed (since preventClose defaults to false)
      expect(closeFn).toHaveBeenCalled();

      // No finish chunk should have been written to the client
      expect(
        writtenChunks.find(
          (c) => (c as Record<string, unknown>).type === 'finish'
        )
      ).toBeUndefined();
    });

    it('should not write finish chunk but still return uiMessages when sendFinish is false', async () => {
      const agent = new DurableAgent({
        model: TEST_MODEL,
        tools: {},
      });

      const writtenChunks: unknown[] = [];
      const mockWritable = new WritableStream({
        write: (chunk) => {
          writtenChunks.push(chunk);
        },
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({ done: true, value: [] }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as MockIterator
      );

      const result = await agent.stream({
        messages: [{ role: 'user', content: 'test' }],
        writable: mockWritable,
        collectUIMessages: true,
        sendFinish: false,
        preventClose: true,
      });

      // uiMessages should be available even with sendFinish=false and preventClose=true
      expect(result.uiMessages).toBeDefined();
      expect(Array.isArray(result.uiMessages)).toBe(true);
    });
  });
});
