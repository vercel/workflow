import {
  type ChatRequestOptions,
  type ChatTransport,
  type PrepareReconnectToStreamRequest,
  type PrepareSendMessagesRequest,
  parseJsonEventStream,
  type UIMessage,
  type UIMessageChunk,
  uiMessageChunkSchema,
} from 'ai';
import { iteratorToStream, streamToIterator } from './stream-iterator.js';

export interface SendMessagesOptions<UI_MESSAGE extends UIMessage> {
  trigger: 'submit-message' | 'regenerate-message';
  chatId: string;
  messageId?: string;
  messages: UI_MESSAGE[];
  abortSignal?: AbortSignal;
}

export interface ReconnectToStreamOptions {
  chatId: string;
}

type OnChatSendMessage<UI_MESSAGE extends UIMessage> = (
  response: Response,
  options: SendMessagesOptions<UI_MESSAGE>
) => void | Promise<void>;

type OnChatEnd = ({
  chatId,
  chunkIndex,
}: {
  chatId: string;
  chunkIndex: number;
}) => void | Promise<void>;

/**
 * Configuration options for the WorkflowChatTransport.
 *
 * @template UI_MESSAGE - The type of UI messages being sent and received,
 *                        must extend the UIMessage interface from the AI SDK.
 */
export interface WorkflowChatTransportOptions<UI_MESSAGE extends UIMessage> {
  /**
   * API endpoint for chat requests
   * Defaults to /api/chat if not provided
   */
  api?: string;

  /**
   * Custom fetch implementation to use for HTTP requests.
   * Defaults to the global fetch function if not provided.
   */
  fetch?: typeof fetch;

  /**
   * Callback invoked after successfully sending messages to the chat endpoint.
   * Useful for tracking chat history and inspecting response headers.
   *
   * @param response - The HTTP response object from the chat endpoint
   * @param options - The original options passed to sendMessages
   */
  onChatSendMessage?: OnChatSendMessage<UI_MESSAGE>;

  /**
   * Callback invoked when a chat stream ends (receives a "finish" chunk).
   * Useful for cleanup operations or state updates.
   *
   * @param chatId - The ID of the chat that ended
   * @param chunkIndex - The total number of chunks received
   */
  onChatEnd?: OnChatEnd;

  /**
   * Maximum number of consecutive errors allowed during reconnection attempts.
   * Defaults to 3 if not provided.
   */
  maxConsecutiveErrors?: number;

  /**
   * Function to prepare the request for sending messages.
   * Allows customizing the API endpoint, headers, credentials, and body.
   */
  prepareSendMessagesRequest?: PrepareSendMessagesRequest<UI_MESSAGE>;

  /**
   * Function to prepare the request for reconnecting to a stream.
   * Allows customizing the API endpoint, headers, and credentials.
   */
  prepareReconnectToStreamRequest?: PrepareReconnectToStreamRequest;
}

/**
 * A transport implementation for managing chat workflows with support for
 * streaming responses and automatic reconnection to interrupted streams.
 *
 * This class implements the ChatTransport interface from the AI SDK and provides
 * reliable message streaming with automatic recovery from network interruptions
 * or function timeouts.
 *
 * @template UI_MESSAGE - The type of UI messages being sent and received,
 *                        must extend the UIMessage interface from the AI SDK.
 *
 * @implements {ChatTransport<UI_MESSAGE>}
 */
export class WorkflowChatTransport<UI_MESSAGE extends UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  private readonly api: string;
  private readonly fetch: typeof fetch;
  private readonly onChatSendMessage?: OnChatSendMessage<UI_MESSAGE>;
  private readonly onChatEnd?: OnChatEnd;
  private readonly maxConsecutiveErrors: number;
  private readonly prepareSendMessagesRequest?: PrepareSendMessagesRequest<UI_MESSAGE>;
  private readonly prepareReconnectToStreamRequest?: PrepareReconnectToStreamRequest;

  /**
   * Creates a new WorkflowChatTransport instance.
   *
   * @param options - Configuration options for the transport
   * @param options.api - API endpoint for chat requests (defaults to '/api/chat')
   * @param options.fetch - Custom fetch implementation (defaults to global fetch)
   * @param options.onChatSendMessage - Callback after sending messages
   * @param options.onChatEnd - Callback when chat stream ends
   * @param options.maxConsecutiveErrors - Maximum consecutive errors for reconnection
   * @param options.prepareSendMessagesRequest - Function to prepare send messages request
   * @param options.prepareReconnectToStreamRequest - Function to prepare reconnect request
   */
  constructor(options: WorkflowChatTransportOptions<UI_MESSAGE> = {}) {
    this.api = options.api ?? '/api/chat';
    this.fetch = options.fetch ?? fetch.bind(globalThis);
    this.onChatSendMessage = options.onChatSendMessage;
    this.onChatEnd = options.onChatEnd;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? 3;
    this.prepareSendMessagesRequest = options.prepareSendMessagesRequest;
    this.prepareReconnectToStreamRequest =
      options.prepareReconnectToStreamRequest;
  }

  /**
   * Sends messages to the chat endpoint and returns a stream of response chunks.
   *
   * This method handles the entire chat lifecycle including:
   * - Sending messages to the /api/chat endpoint
   * - Streaming response chunks
   * - Automatic reconnection if the stream is interrupted
   *
   * @param options - Options for sending messages
   * @param options.trigger - The type of message submission ('submit-message' or 'regenerate-message')
   * @param options.chatId - Unique identifier for this chat session
   * @param options.messageId - Optional message ID for tracking specific messages
   * @param options.messages - Array of UI messages to send
   * @param options.abortSignal - Optional AbortSignal to cancel the request
   *
   * @returns A ReadableStream of UIMessageChunk objects containing the response
   * @throws Error if the fetch request fails or returns a non-OK status
   */
  async sendMessages(
    options: SendMessagesOptions<UI_MESSAGE> & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    return iteratorToStream(this.sendMessagesIterator(options), {
      signal: options.abortSignal,
    });
  }

  private async *sendMessagesIterator(
    options: SendMessagesOptions<UI_MESSAGE>
  ): AsyncGenerator<UIMessageChunk> {
    const { chatId, messages, abortSignal, trigger, messageId } = options;

    // We keep track of if the "finish" chunk is received to determine
    // if we need to reconnect, and keep track of the chunk index to resume from.
    let gotFinish = false;
    let chunkIndex = 0;

    // Prepare the request using the configurator if provided
    const requestConfig = this.prepareSendMessagesRequest
      ? await this.prepareSendMessagesRequest({
          id: chatId,
          messages,
          requestMetadata: undefined,
          body: undefined,
          credentials: undefined,
          headers: undefined,
          api: this.api,
          trigger,
          messageId,
        })
      : undefined;

    const url = requestConfig?.api ?? this.api;
    const res = await this.fetch(url, {
      method: 'POST',
      body: JSON.stringify(requestConfig?.body ?? { messages }),
      headers: requestConfig?.headers,
      credentials: requestConfig?.credentials,
      signal: abortSignal,
    });

    if (!res.ok || !res.body) {
      throw new Error(
        `Failed to fetch chat: ${res.status} ${await res.text()}`
      );
    }

    const workflowRunId = res.headers.get('x-workflow-run-id');
    if (!workflowRunId) {
      throw new Error(
        'Workflow run ID not found in "x-workflow-run-id" response header'
      );
    }

    // Notify the caller that the chat POST request was sent.
    // This is useful for tracking the chat history on the client
    // side and allows for inspecting response headers.
    await this.onChatSendMessage?.(res, options);

    // Flush the initial stream until the end or an error occurs
    try {
      const chunkStream = parseJsonEventStream({
        stream: res.body,
        schema: uiMessageChunkSchema,
      });
      for await (const chunk of streamToIterator(chunkStream)) {
        if (!chunk.success) {
          throw chunk.error;
        }

        chunkIndex++;

        yield chunk.value;

        if (chunk.value.type === 'finish') {
          gotFinish = true;
        }
      }
    } catch (error) {
      console.error('Error in chat POST stream', error);
    }

    if (gotFinish) {
      await this.onFinish(gotFinish, { chatId, chunkIndex });
    } else {
      // If the initial POST request did not include the "finish" chunk,
      // we need to reconnect to the stream. This could indicate that a
      // network error occurred or the Vercel Function timed out.
      yield* this.reconnectToStreamIterator(options, workflowRunId, chunkIndex);
    }
  }

  /**
   * Reconnects to an existing chat stream that was previously interrupted.
   *
   * This method is useful for resuming a chat session after network issues,
   * page refreshes, or Vercel Function timeouts.
   *
   * @param options - Options for reconnecting to the stream
   * @param options.chatId - The chat ID to reconnect to
   *
   * @returns A ReadableStream of UIMessageChunk objects
   * @throws Error if the reconnection request fails or returns a non-OK status
   */
  async reconnectToStream(
    options: ReconnectToStreamOptions & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const it = this.reconnectToStreamIterator(options);
    return iteratorToStream(it);
  }

  private async *reconnectToStreamIterator(
    options: ReconnectToStreamOptions & ChatRequestOptions,
    workflowRunId?: string,
    initialChunkIndex = 0
  ): AsyncGenerator<UIMessageChunk> {
    let chunkIndex = initialChunkIndex;

    const defaultApi = `${this.api}/${encodeURIComponent(workflowRunId ?? options.chatId)}/stream`;

    // Prepare the request using the configurator if provided
    const requestConfig = this.prepareReconnectToStreamRequest
      ? await this.prepareReconnectToStreamRequest({
          id: options.chatId,
          requestMetadata: undefined,
          body: undefined,
          credentials: undefined,
          headers: undefined,
          api: defaultApi,
        })
      : undefined;

    const baseUrl = requestConfig?.api ?? defaultApi;

    let gotFinish = false;
    let consecutiveErrors = 0;

    while (!gotFinish) {
      const url = `${baseUrl}?startIndex=${chunkIndex}`;
      const res = await this.fetch(url, {
        headers: requestConfig?.headers,
        credentials: requestConfig?.credentials,
      });

      if (!res.ok || !res.body) {
        throw new Error(
          `Failed to fetch chat: ${res.status} ${await res.text()}`
        );
      }

      try {
        const chunkStream = parseJsonEventStream({
          stream: res.body,
          schema: uiMessageChunkSchema,
        });
        for await (const chunk of streamToIterator(chunkStream)) {
          if (!chunk.success) {
            throw chunk.error;
          }

          chunkIndex++;

          yield chunk.value;

          if (chunk.value.type === 'finish') {
            gotFinish = true;
          }
        }
        // Reset consecutive error count only after successful stream parsing
        consecutiveErrors = 0;
      } catch (error) {
        console.error('Error in chat GET reconnectToStream', error);
        consecutiveErrors++;

        if (consecutiveErrors >= this.maxConsecutiveErrors) {
          throw new Error(
            `Failed to reconnect after ${this.maxConsecutiveErrors} consecutive errors. Last error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    await this.onFinish(gotFinish, { chatId: options.chatId, chunkIndex });
  }

  private async onFinish(
    gotFinish: boolean,
    { chatId, chunkIndex }: { chatId: string; chunkIndex: number }
  ) {
    if (gotFinish) {
      await this.onChatEnd?.({ chatId, chunkIndex });
    } else {
      throw new Error('No finish chunk received');
    }
  }
}
