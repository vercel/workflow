import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowStreams } from './use-workflow-streams';

vi.mock('~/lib/rpc-client', () => ({
  fetchStreams: vi.fn(),
}));

import { fetchStreams } from '~/lib/rpc-client';

const env = { SOME_VAR: 'test' };

function rpcStreams(streams: string[]) {
  return Promise.resolve({ success: true as const, data: streams });
}

function rpcError(message: string) {
  return Promise.resolve({
    success: false as const,
    error: {
      message,
      layer: 'API' as const,
      cause: 'bad',
      request: { operation: 'fetchStreams', params: {} },
    },
  });
}

describe('useWorkflowStreams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows streams after loading', async () => {
    vi.mocked(fetchStreams).mockReturnValue(
      rpcStreams(['stream-1', 'stream-2'])
    );

    const { result } = renderHook(() => useWorkflowStreams(env, 'run-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.streams).toEqual(['stream-1', 'stream-2']);
    expect(result.current.error).toBeNull();
  });

  it('shows error when fetch fails', async () => {
    vi.mocked(fetchStreams).mockReturnValue(rpcError('streams error'));

    const { result } = renderHook(() => useWorkflowStreams(env, 'run-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error?.message).toBe('streams error');
    expect(result.current.streams).toEqual([]);
  });

  it('refresh() reloads the stream list', async () => {
    vi.mocked(fetchStreams)
      .mockReturnValueOnce(rpcStreams(['stream-1']))
      .mockReturnValue(rpcStreams(['stream-1', 'stream-2']));

    const { result } = renderHook(() => useWorkflowStreams(env, 'run-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.streams).toEqual(['stream-1']);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.streams).toEqual(['stream-1', 'stream-2']);
    });
  });

  it('updates stream list when runId changes', async () => {
    vi.mocked(fetchStreams)
      .mockReturnValueOnce(rpcStreams(['stream-a']))
      .mockReturnValue(rpcStreams(['stream-b']));

    const { result, rerender } = renderHook(
      ({ runId }: { runId: string }) => useWorkflowStreams(env, runId),
      { initialProps: { runId: 'run-1' } }
    );

    await waitFor(() => {
      expect(result.current.streams).toEqual(['stream-a']);
    });

    rerender({ runId: 'run-2' });

    await waitFor(() => {
      expect(result.current.streams).toEqual(['stream-b']);
    });
  });
});
