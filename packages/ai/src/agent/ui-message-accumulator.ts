import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';

/**
 * Accumulates UIMessageChunks into UIMessage[] while forwarding all chunks
 * to a wrapped writable stream.
 *
 * This allows collecting the final UIMessage[] representation of a conversation
 * while still streaming chunks to the client in real-time, with minimal impact
 * to the DurableAgent's streamTextIterator.
 *
 * This file might seem complicated, but it's the closest to the internal
 * implementation that AI SDK uses to collect UIMessage[] for return to the
 * onFinish callback on toUIMessageStreamResponse.
 */
export class UIMessageAccumulator {
  private chunks: UIMessageChunk[] = [];
  private readonly originalWritable: WritableStream<UIMessageChunk>;
  private messagesPromise: Promise<UIMessage[]> | null = null;

  /**
   * The writable stream that should be passed to the streaming function.
   * It forwards all chunks to the original writable while collecting them for accumulation.
   */
  public readonly writable: WritableStream<UIMessageChunk>;

  constructor(originalWritable: WritableStream<UIMessageChunk>) {
    this.originalWritable = originalWritable;

    // Create a writable stream that collects chunks and forwards them to the original
    // We don't use pipeTo because it locks the destination stream, which prevents
    // the caller from later calling close() on it.
    this.writable = new WritableStream<UIMessageChunk>({
      write: async (chunk) => {
        this.chunks.push(chunk);
        // Forward to the original writable
        const writer = this.originalWritable.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
      },
      // Don't close the original - that's handled by the caller
      close: async () => {
        // No-op: we don't close the original writable
      },
      abort: async (reason) => {
        // Forward abort to the original
        await this.originalWritable.abort(reason);
      },
    });
  }

  /**
   * Get the accumulated UIMessage[] from all collected chunks.
   * This should be called after streaming is complete.
   *
   * @returns Promise resolving to the accumulated UIMessage array
   */
  async getMessages(): Promise<UIMessage[]> {
    // Cache the promise so we only process once
    if (this.messagesPromise) {
      return this.messagesPromise;
    }

    this.messagesPromise = this.processChunksToMessages();
    return this.messagesPromise;
  }

  private async processChunksToMessages(): Promise<UIMessage[]> {
    if (this.chunks.length === 0) {
      return [];
    }

    // Create a readable stream from the collected chunks
    const chunkStream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        for (const chunk of this.chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    // Use the AI SDK's readUIMessageStream to convert chunks to messages
    const messageStream = readUIMessageStream({
      stream: chunkStream,
      onError: (error) => {
        console.error('Error processing UI message chunks:', error);
      },
    });

    // Collect all message updates and return the final state
    const messages: UIMessage[] = [];
    for await (const message of messageStream) {
      // readUIMessageStream yields updated versions of the message as it's built
      // We want to collect the final state of each message
      // Messages are identified by their id, so we update in place
      const existingIndex = messages.findIndex((m) => m.id === message.id);
      if (existingIndex >= 0) {
        messages[existingIndex] = message;
      } else {
        messages.push(message);
      }
    }

    return messages;
  }

  /**
   * Get the raw collected chunks (useful for debugging or custom processing).
   */
  getChunks(): UIMessageChunk[] {
    return [...this.chunks];
  }
}
