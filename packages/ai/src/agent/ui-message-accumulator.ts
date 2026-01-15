import type { UIMessageChunk } from 'ai';

/**
 * Accumulates UIMessageChunks while forwarding all chunks to a wrapped writable stream.
 *
 * This allows collecting chunks for later conversion to UIMessage[] representation
 * while still streaming chunks to the client in real-time.
 *
 * Note: The actual conversion from chunks to UIMessage[] must happen in a step function
 * since it requires stream operations, which are not allowed in workflow context.
 * Use `convertChunksToUIMessages()` step function for the conversion.
 */
export class UIMessageAccumulator {
  private chunks: UIMessageChunk[] = [];
  private readonly originalWritable: WritableStream<UIMessageChunk>;

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
   * Get the raw collected chunks.
   * Use `convertChunksToUIMessages()` step function to convert these to UIMessage[].
   */
  getChunks(): UIMessageChunk[] {
    return [...this.chunks];
  }
}
