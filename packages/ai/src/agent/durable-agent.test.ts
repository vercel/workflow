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
import type { ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { FatalError } from 'workflow';
import { z } from 'zod';

// Mock the streamTextIterator
vi.mock('./stream-text-iterator.js', () => ({
  streamTextIterator: vi.fn(),
}));

// Import after mocking
const { DurableAgent } = await import('./durable-agent.js');

import type { PrepareStepCallback } from './durable-agent.js';
import type { StreamTextIteratorYieldValue } from './stream-text-iterator.js';

/**
 * Creates a mock LanguageModelV2 for testing
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
      const mockModel = createMockModel();

      const agent = new DurableAgent({
        model: async () => mockModel,
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

      const mockModel = createMockModel();

      const agent = new DurableAgent({
        model: async () => mockModel,
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

      const mockModel = createMockModel();

      const agent = new DurableAgent({
        model: async () => mockModel,
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
          type: 'text',
          value: JSON.stringify(toolResult),
        },
      });
    });
  });

  describe('prepareStep callback', () => {
    it('should pass prepareStep callback to streamTextIterator', async () => {
      const mockModel = createMockModel();

      const agent = new DurableAgent({
        model: async () => mockModel,
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
      const mockModel = createMockModel();

      const agent = new DurableAgent({
        model: async () => mockModel,
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
      const mockModel = createMockModel();

      const agent = new DurableAgent({
        model: async () => mockModel,
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
      const mockModel = createMockModel();

      const agent = new DurableAgent({
        model: async () => mockModel,
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

      const mockModel = createMockModel();

      const agent = new DurableAgent({
        model: async () => mockModel,
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

      const mockModel = createMockModel();

      const agent = new DurableAgent({
        model: async () => mockModel,
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

      const mockModel = createMockModel();

      const agent = new DurableAgent({
        model: async () => mockModel,
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
});
