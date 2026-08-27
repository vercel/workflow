import type {
  GetChunksOptions,
  StreamChunksResponse,
  StreamInfoResponse,
} from '@workflow/world';

const PAGE_LIMIT = 100;
const INITIAL_POLL_MS = 50;
const MAX_POLL_MS = 1_000;

export interface IndexedStreamFallbackSource {
  getChunks(options: GetChunksOptions): Promise<StreamChunksResponse>;
  getInfo(): Promise<StreamInfoResponse>;
}

/** Rare post-WebSocket recovery path that preserves durable chunk indexes. */
export function createIndexedStreamFallback(
  startIndex: number,
  source: IndexedStreamFallbackSource
): ReadableStream<Uint8Array> {
  let expected = startIndex;
  let page: StreamChunksResponse['data'] = [];
  let cursor: string | undefined;
  let pageInitialized = false;
  let pollDelayMs = INITIAL_POLL_MS;
  let cancelled = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollResolve: (() => void) | undefined;

  const wait = () =>
    new Promise<void>((resolve) => {
      pollResolve = resolve;
      pollTimer = setTimeout(resolve, pollDelayMs);
      pollTimer.unref?.();
    }).finally(() => {
      pollTimer = undefined;
      pollResolve = undefined;
    });

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        while (!cancelled) {
          const chunk = page.shift();
          if (chunk) {
            if (chunk.index < expected) continue;
            if (chunk.index > expected) {
              controller.error(
                new Error(
                  `indexed stream fallback gap: expected ${expected}, received ${chunk.index}`
                )
              );
              return;
            }
            expected++;
            controller.enqueue(chunk.data);
            return;
          }

          const options: GetChunksOptions = pageInitialized
            ? {
                limit: PAGE_LIMIT,
                ...(cursor ? { cursor } : { startIndex: expected }),
              }
            : { limit: PAGE_LIMIT, startIndex: expected };
          const result = await source.getChunks(options);
          pageInitialized = true;
          page = [...result.data];
          cursor = result.cursor ?? undefined;
          if (page.length > 0) {
            pollDelayMs = INITIAL_POLL_MS;
            continue;
          }

          const info = await source.getInfo();
          if (info.done && expected > info.tailIndex) {
            controller.close();
            return;
          }
          await wait();
          pollDelayMs = Math.min(pollDelayMs * 2, MAX_POLL_MS);
          pageInitialized = false;
          cursor = undefined;
        }
      },
      cancel() {
        cancelled = true;
        if (pollTimer) clearTimeout(pollTimer);
        pollResolve?.();
      },
    },
    { highWaterMark: 1 }
  );
}
