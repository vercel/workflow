import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamResponse } from '~/lib/client/workflow-streams';
import { readStream } from '~/lib/workflow-api-client';
import { useStreamReader } from './use-stream-reader';

vi.mock('~/lib/workflow-api-client', () => ({
  readStream: vi.fn(),
}));

const env = {};

function emptyStreamResponse(done: boolean): StreamResponse {
  return {
    body: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    cursor: null,
    done,
  };
}

describe('useStreamReader status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not report live while the initial request is loading', async () => {
    let resolveRead: (response: StreamResponse) => void = () => {};
    vi.mocked(readStream).mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      })
    );

    const { result, unmount } = renderHook(() =>
      useStreamReader(env, 'stream-1', 'run-1', null, 'running')
    );

    expect(result.current.isInitialLoading).toBe(true);
    expect(result.current.isLive).toBe(false);

    resolveRead(emptyStreamResponse(false));

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });
    expect(result.current.isLive).toBe(true);

    unmount();
  });

  it('does not report a completed stream as live', async () => {
    vi.mocked(readStream).mockResolvedValue(emptyStreamResponse(true));

    const { result } = renderHook(() =>
      useStreamReader(env, 'stream-1', 'run-1', null, 'running')
    );

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });
    expect(result.current.isLive).toBe(false);
  });

  it('does not report an open stream as live after the run completes', async () => {
    vi.mocked(readStream).mockResolvedValue(emptyStreamResponse(false));

    const { result } = renderHook(() =>
      useStreamReader(env, 'stream-1', 'run-1', null, 'completed')
    );

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });
    expect(result.current.isLive).toBe(false);
  });
});
