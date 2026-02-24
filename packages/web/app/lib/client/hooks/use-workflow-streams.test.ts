import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowStreams } from './use-workflow-streams';

vi.mock('~/lib/rpc-client', () => ({
  fetchStreams: vi.fn(),
}));

import { fetchStreams } from '~/lib/rpc-client';

const env = { SOME_VAR: 'test' };

describe('useWorkflowStreams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches streams on mount', async () => {
    vi.mocked(fetchStreams).mockResolvedValue({
      success: true,
      data: ['stream-1', 'stream-2'],
    });

    const { result } = renderHook(() => useWorkflowStreams(env, 'run-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.streams).toEqual(['stream-1', 'stream-2']);
    expect(result.current.error).toBeNull();
  });

  it('handles error', async () => {
    vi.mocked(fetchStreams).mockResolvedValue({
      success: false,
      error: {
        message: 'streams error',
        layer: 'API' as const,
        cause: 'bad',
        request: { operation: 'fetchStreams', params: {} },
      },
    });

    const { result } = renderHook(() => useWorkflowStreams(env, 'run-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.streams).toEqual([]);
  });
});
