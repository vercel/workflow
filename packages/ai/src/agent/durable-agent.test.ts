/**
 * Tests for DurableAgent
 *
 * These tests focus on error handling in tool execution,
 * particularly for FatalError conversion to tool result errors.
 */
import type {
  LanguageModelV2,
  LanguageModelV2ToolCall,
} from '@ai-sdk/provider';
import { FatalError } from 'workflow';
import { describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { z } from 'zod';

// Mock the streamTextIterator
vi.mock('./stream-text-iterator.js', () => ({
  streamTextIterator: vi.fn(),
}));

// Import after mocking
const { DurableAgent } = await import('./durable-agent.js');

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
      const mockModel: LanguageModelV2 = {
        specificationVersion: 'v2' as const,
        provider: 'test',
        modelId: 'test-model',
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      };

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
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: [
              {
                toolCallId: 'test-call-id',
                toolName: 'testTool',
                input: '{}',
              } as LanguageModelV2ToolCall,
            ],
          })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as AsyncGenerator
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

      const mockModel: LanguageModelV2 = {
        specificationVersion: 'v2' as const,
        provider: 'test',
        modelId: 'test-model',
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      };

      const agent = new DurableAgent({
        model: async () => mockModel,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi.fn().mockResolvedValueOnce({
          done: false,
          value: [
            {
              toolCallId: 'test-call-id',
              toolName: 'testTool',
              input: '{}',
            } as LanguageModelV2ToolCall,
          ],
        }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as AsyncGenerator
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

      const mockModel: LanguageModelV2 = {
        specificationVersion: 'v2' as const,
        provider: 'test',
        modelId: 'test-model',
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      };

      const agent = new DurableAgent({
        model: async () => mockModel,
        tools,
      });

      const mockWritable = new WritableStream({
        write: vi.fn(),
        close: vi.fn(),
      });

      const { streamTextIterator } = await import('./stream-text-iterator.js');
      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: [
              {
                toolCallId: 'test-call-id',
                toolName: 'testTool',
                input: '{}',
              } as LanguageModelV2ToolCall,
            ],
          })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      };
      vi.mocked(streamTextIterator).mockReturnValue(
        mockIterator as unknown as AsyncGenerator
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
});
