import { act, renderHook, waitFor } from '@testing-library/react';
import type { RunUsage } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunUsage } from './use-run-usage';

vi.mock('~/lib/rpc-client', () => ({
  fetchRunUsage: vi.fn(),
}));

import { fetchRunUsage } from '~/lib/rpc-client';

const env = {};

const usage = (runId: string, events: number): RunUsage => ({
  runId,
  status: 'running',
  workflowName: 'workflow//./src/w//wf',
  billed: false,
  inProgress: true,
  events,
  billableEvents: events,
  retries: { count: 0, events: 0 },
  runEvents: {
    events: 0,
    byType: { created: 0, started: 0, completed: 0, failed: 0, cancelled: 0 },
  },
  stepEvents: {
    steps: 0,
    events: 0,
    byType: {
      created: 0,
      started: 0,
      completed: 0,
      failed: 0,
      retrying: 0,
      other: 0,
    },
  },
  eventsBySpan: [],
  dataWritten: {
    bytes: 0,
    byEntity: { run: 0, step: 0, hook: 0, stream: 0 },
    source: 'log',
  },
  dataPurged: false,
  dataRetained: null,
});

type Result = Awaited<ReturnType<typeof fetchRunUsage>>;

/** A response the test releases when it chooses. */
function deferred() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (data: RunUsage | null): Result => ({ success: true, data });

beforeEach(() => {
  vi.mocked(fetchRunUsage).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRunUsage', () => {
  it("reads the World's count", async () => {
    vi.mocked(fetchRunUsage).mockResolvedValue(ok(usage('wrun_a', 512)));
    const { result } = renderHook(() => useRunUsage(env, 'wrun_a'));
    await waitFor(() => expect(result.current.usage?.events).toBe(512));
    expect(fetchRunUsage).toHaveBeenCalledWith(env, 'wrun_a');
  });

  it('reads null from a World without usage', async () => {
    vi.mocked(fetchRunUsage).mockResolvedValue(ok(null));
    const { result } = renderHook(() => useRunUsage(env, 'wrun_a'));
    await waitFor(() => expect(result.current.usage).toBeNull());
  });

  it('keeps the newest read when an older one lands after it', async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(fetchRunUsage)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useRunUsage(env, 'wrun_a'));

    let refreshed!: Promise<void>;
    act(() => {
      refreshed = result.current.refresh();
    });
    await act(async () => {
      second.resolve(ok(usage('wrun_a', 20)));
      await refreshed;
    });
    expect(result.current.usage?.events).toBe(20);

    // The first read saw a shorter log; it must not replace the newer count.
    await act(async () => {
      first.resolve(ok(usage('wrun_a', 10)));
      await first.promise;
    });
    expect(result.current.usage?.events).toBe(20);
    expect(result.current.loading).toBe(false);
  });

  it("never shows one run's usage on another", async () => {
    const forA = deferred();
    vi.mocked(fetchRunUsage)
      .mockReturnValueOnce(forA.promise)
      .mockResolvedValueOnce(ok(usage('wrun_b', 7)));
    const { result, rerender } = renderHook(
      ({ runId }) => useRunUsage(env, runId),
      { initialProps: { runId: 'wrun_a' } }
    );
    rerender({ runId: 'wrun_b' });
    await waitFor(() => expect(result.current.usage?.runId).toBe('wrun_b'));

    await act(async () => {
      forA.resolve(ok(usage('wrun_a', 99)));
      await forA.promise;
    });
    expect(result.current.usage?.runId).toBe('wrun_b');
  });

  it('keeps the last numbers when a refresh fails', async () => {
    vi.mocked(fetchRunUsage)
      .mockResolvedValueOnce(ok(usage('wrun_a', 5)))
      .mockResolvedValueOnce({
        success: false,
        error: { message: 'database is locked', layer: 'API' },
      });
    const { result } = renderHook(() => useRunUsage(env, 'wrun_a'));
    await waitFor(() => expect(result.current.usage?.events).toBe(5));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.usage?.events).toBe(5);
    expect(result.current.error?.message).toContain('database is locked');
  });

  it('polls while the run is live, skipping a poll while a read is in flight', async () => {
    vi.useFakeTimers();
    const slow = deferred();
    vi.mocked(fetchRunUsage)
      .mockResolvedValueOnce(ok(usage('wrun_a', 1)))
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(ok(usage('wrun_a', 3)));
    renderHook(() =>
      useRunUsage(env, 'wrun_a', { live: true, refreshInterval: 1000 })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
    // The second read has not answered: these ticks do not stack reads.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);

    // That read took 3 s, so the next poll waits 10 × 3 s, not 1 s.
    await act(async () => {
      slow.resolve(ok(usage('wrun_a', 2)));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(3);
  });

  it('polls at the interval while reads are fast', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchRunUsage).mockResolvedValue(ok(usage('wrun_a', 1)));
    renderHook(() =>
      useRunUsage(env, 'wrun_a', { live: true, refreshInterval: 1000 })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(6);
  });

  it('waits ten times as long as a slow read before the next, then speeds up again', async () => {
    vi.useFakeTimers();
    /** A read that answers after `ms`. */
    const after = (ms: number, events: number) =>
      new Promise<Result>((resolve) =>
        setTimeout(() => resolve(ok(usage('wrun_a', events))), ms)
      );
    vi.mocked(fetchRunUsage)
      .mockReturnValueOnce(after(0, 1))
      .mockImplementationOnce(() => after(500, 2))
      .mockImplementationOnce(() => after(0, 3))
      .mockImplementation(() => after(0, 4));
    const { result } = renderHook(() =>
      useRunUsage(env, 'wrun_a', { live: true, refreshInterval: 1000 })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The 500 ms read starts at 1 s and answers at 1.5 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
    expect(result.current.usage?.events).toBe(2);
    // Next poll: 10 × 500 ms = 5 s later, at 6.5 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(3);
    // That one was fast: back to the 1 s interval, not another 5 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(4);
    expect(result.current.usage?.events).toBe(4);
  });

  it('reads the final numbers once when the run finishes, then stops polling', async () => {
    vi.useFakeTimers();
    // While it runs, reads say so; the read after it finishes does not.
    vi.mocked(fetchRunUsage)
      .mockResolvedValueOnce(ok(usage('wrun_a', 1)))
      .mockResolvedValue(
        ok({ ...usage('wrun_a', 2), status: 'completed', inProgress: false })
      );
    const { rerender } = renderHook(
      ({ live }) => useRunUsage(env, 'wrun_a', { live, refreshInterval: 1000 }),
      { initialProps: { live: true } }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(1);

    rerender({ live: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
  });

  it('does not read twice when the run turns out to be live on first load', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchRunUsage).mockResolvedValue(ok(usage('wrun_a', 3)));
    // The page renders before it has read the run (not live), then reads it
    // as running: `live` flips to true right after the first usage read.
    const { rerender } = renderHook(
      ({ live }) => useRunUsage(env, 'wrun_a', { live, refreshInterval: 1000 }),
      { initialProps: { live: false } }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    rerender({ live: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(1);

    // The next read is the poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
  });

  it('does not poll a World without usage', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchRunUsage).mockResolvedValue(ok(null));
    renderHook(() =>
      useRunUsage(env, 'wrun_a', { live: true, refreshInterval: 1000 })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(1);
  });

  it('keeps polling a usage read that came back in progress, even once the run reads as finished', async () => {
    // The page loads the run after it finished (`live` is false from the
    // start), but the usage read was taken while it still ran.
    vi.useFakeTimers();
    const finished: RunUsage = {
      ...usage('wrun_a', 9),
      status: 'completed',
      inProgress: false,
    };
    vi.mocked(fetchRunUsage)
      .mockResolvedValueOnce(ok(usage('wrun_a', 5)))
      .mockResolvedValueOnce(ok(finished));
    const { result } = renderHook(() =>
      useRunUsage(env, 'wrun_a', { live: false, refreshInterval: 1000 })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.usage?.inProgress).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
    expect(result.current.usage).toMatchObject({
      events: 9,
      inProgress: false,
    });

    // Finished, and the run is not live: polling stops.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
  });

  it('does not poll a finished run whose usage is complete', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchRunUsage).mockResolvedValue(
      ok({ ...usage('wrun_a', 9), status: 'completed', inProgress: false })
    );
    renderHook(() =>
      useRunUsage(env, 'wrun_a', { live: false, refreshInterval: 1000 })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(1);
  });

  it('reads nothing while disabled', async () => {
    renderHook(() => useRunUsage(env, 'wrun_a', { enabled: false }));
    await act(async () => {});
    expect(fetchRunUsage).not.toHaveBeenCalled();
  });
});
