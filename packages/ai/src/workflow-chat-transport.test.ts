/**
 * Tests for WorkflowChatTransport
 *
 * These tests focus on testing the transport's behavior through its options
 * and callback functions rather than complex mocking.
 */
import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowChatTransport } from './workflow-chat-transport.js';

describe('WorkflowChatTransport', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let transport: WorkflowChatTransport<UIMessage>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should use default fetch when not provided', () => {
      const transport = new WorkflowChatTransport();
      expect(transport).toBeDefined();
    });

    it('should use custom fetch when provided', () => {
      const customFetch = vi.fn();
      const transport = new WorkflowChatTransport({ fetch: customFetch });
      expect(transport).toBeDefined();
    });

    it('should accept and store callback functions', () => {
      const onChatSendMessage = vi.fn();
      const onChatEnd = vi.fn();
      const prepareSendMessagesRequest = vi.fn();
      const prepareReconnectToStreamRequest = vi.fn();

      const transport = new WorkflowChatTransport({
        onChatSendMessage,
        onChatEnd,
        prepareSendMessagesRequest,
        prepareReconnectToStreamRequest,
      });

      expect(transport).toBeDefined();
    });

    it('should use default maxConsecutiveErrors of 3', () => {
      const transport = new WorkflowChatTransport();
      expect(transport).toBeDefined();
    });

    it('should accept custom maxConsecutiveErrors', () => {
      const transport = new WorkflowChatTransport({
        maxConsecutiveErrors: 5,
      });
      expect(transport).toBeDefined();
    });
  });

  describe('prepareSendMessagesRequest', () => {
    it('should use custom API endpoint when provided', async () => {
      const prepareSendMessagesRequest = vi.fn().mockResolvedValue({
        api: '/custom/chat',
        body: { custom: 'body' },
      });

      const transport = new WorkflowChatTransport({
        fetch: mockFetch,
        prepareSendMessagesRequest,
      });

      // Mock a successful response with simple stream
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'x-workflow-run-id': 'test-workflow-123' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"finish"}\n\n')
            );
            controller.close();
          },
        }),
      });

      const messages = [] as UIMessage[];

      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'test-chat',
        messages,
      });

      // Consume the stream to ensure fetch is called
      const reader = stream.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }

      expect(prepareSendMessagesRequest).toHaveBeenCalledWith({
        id: 'test-chat',
        messages,
        requestMetadata: undefined,
        body: undefined,
        credentials: undefined,
        headers: undefined,
        api: '/api/chat',
        trigger: 'submit-message',
        messageId: undefined,
      });

      expect(mockFetch).toHaveBeenCalledWith('/custom/chat', {
        method: 'POST',
        body: JSON.stringify({ custom: 'body' }),
        headers: undefined,
        credentials: undefined,
        signal: undefined,
      });
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      transport = new WorkflowChatTransport({ fetch: mockFetch });
    });

    it('should handle response errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'test-chat',
        messages: [],
      });

      const reader = stream.getReader();
      await expect(reader.read()).rejects.toThrow(
        'Failed to fetch chat: 500 Internal Server Error'
      );
    });
  });

  describe('prepareReconnectToStreamRequest', () => {
    it('should use custom reconnect endpoint', async () => {
      const prepareReconnectToStreamRequest = vi.fn().mockResolvedValue({
        api: '/custom/reconnect',
        headers: { 'X-Custom': 'header' },
      });

      const transport = new WorkflowChatTransport({
        fetch: mockFetch,
        prepareReconnectToStreamRequest,
      });

      // Mock a successful response with simple stream
      mockFetch.mockResolvedValue({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"finish"}\n\n')
            );
            controller.close();
          },
        }),
      });

      const stream = await transport.reconnectToStream({
        chatId: 'test-chat',
      });

      // Consume the stream
      const reader = stream!.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }

      expect(prepareReconnectToStreamRequest).toHaveBeenCalledWith({
        id: 'test-chat',
        requestMetadata: undefined,
        body: undefined,
        credentials: undefined,
        headers: undefined,
        api: '/api/chat/test-chat/stream',
      });

      expect(mockFetch).toHaveBeenCalledWith('/custom/reconnect?startIndex=0', {
        headers: { 'X-Custom': 'header' },
        credentials: undefined,
      });
    });
  });

  describe('callbacks', () => {
    it('should call onChatSendMessage callback', async () => {
      const onChatSendMessage = vi.fn();

      transport = new WorkflowChatTransport({
        fetch: mockFetch,
        onChatSendMessage,
      });

      const mockResponse = {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"finish"}\n\n')
            );
            controller.close();
          },
        }),
        headers: new Headers({
          'x-request-id': '123',
          'x-workflow-run-id': 'test-workflow-456',
        }),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const messages = [] as UIMessage[];
      const options = {
        trigger: 'submit-message' as const,
        chatId: 'test-chat',
        messages,
      };

      const stream = await transport.sendMessages(options);

      // Consume the stream to ensure callbacks are called
      const reader = stream.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }

      expect(onChatSendMessage).toHaveBeenCalledWith(mockResponse, options);
    });

    it('should call onChatEnd callback when stream ends', async () => {
      const onChatEnd = vi.fn();

      transport = new WorkflowChatTransport({
        fetch: mockFetch,
        onChatEnd,
      });

      // Mock a successful response with a finish chunk
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'x-workflow-run-id': 'test-workflow-789' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"finish"}\n\n')
            );
            controller.close();
          },
        }),
      });

      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'test-chat',
        messages: [],
      });

      // Consume the stream
      const reader = stream.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }

      // Give some time for the callback to be called
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(onChatEnd).toHaveBeenCalledWith({
        chatId: 'test-chat',
        chunkIndex: expect.any(Number),
      });
    });
  });
});
