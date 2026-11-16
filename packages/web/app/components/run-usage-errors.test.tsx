import {
  act,
  cleanup,
  fireEvent,
  render as renderRaw,
  screen,
  waitFor,
} from '@testing-library/react';
import { TooltipProvider } from '@workflow/web-shared';
import { buildRunUsage, type RunUsage } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunUsage } from '~/lib/client/hooks/use-run-usage';
import { RunUsageHeaderStats, RunUsagePanel, usageVisible } from './run-usage';

vi.mock('~/lib/rpc-client', () => ({ fetchRunUsage: vi.fn() }));

import { fetchRunUsage } from '~/lib/rpc-client';

const env = {};

type Result = Awaited<ReturnType<typeof fetchRunUsage>>;
const ok = (data: RunUsage | null): Result => ({ success: true, data });
const failure = (message: string): Result => ({
  success: false,
  error: { message, layer: 'API' },
});

const usage = (events: number, status: RunUsage['status'] = 'completed') =>
  buildRunUsage({
    runId: 'wrun_a',
    status,
    workflowName: 'workflow//./src/w//wf',
    eventGroups: [{ eventType: 'run_created', events, bytes: 2000 }],
    stepGroups: [],
    streamBytes: 0,
  });

/**
 * The run page's usage wiring, as run-detail-view.tsx has it: the same
 * hook, visibility rule and props, the header above and the Usage tab below.
 */
function RunPageUsage({
  live,
  isLocalBackend = true,
}: {
  live: boolean;
  isLocalBackend?: boolean;
}) {
  const state = useRunUsage(env, 'wrun_a', { live, refreshInterval: 1000 });
  if (!usageVisible(state.usage, isLocalBackend)) return null;
  return (
    <>
      <div data-testid="header">
        <RunUsageHeaderStats
          usage={state.usage ?? undefined}
          error={state.error}
          onOpenUsage={() => {}}
        />
      </div>
      <div data-testid="usage-tab">
        <RunUsagePanel
          usage={state.usage ?? undefined}
          error={state.error}
          onRetry={state.refresh}
          retrying={state.loading}
        />
      </div>
    </>
  );
}

/** A response the test releases when it chooses. */
function pending() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const skeletons = (container: HTMLElement) =>
  container.querySelectorAll('.animate-pulse').length;

beforeEach(() => vi.mocked(fetchRunUsage).mockReset());

/** The app's root provides tooltips; so does each test. */
const render = (ui: React.ReactElement) =>
  renderRaw(ui, { wrapper: TooltipProvider });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a failed first usage read on a finished run', () => {
  it('does not leave the header loading forever', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchRunUsage).mockResolvedValue(failure('database is locked'));
    const { container } = render(<RunPageUsage live={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // A finished run does not poll: no later read replaces this.
    expect(fetchRunUsage).toHaveBeenCalledTimes(1);
    const header = screen.getByTestId('header');
    expect(skeletons(header)).toBe(0);
    expect(screen.getByTestId('run-usage-events').textContent).toBe('—');
    expect(screen.getByTestId('run-usage-storage').textContent).toBe('—');
    expect(screen.getByTestId('run-usage-events').getAttribute('title')).toBe(
      "Could not read this run's usage: database is locked"
    );
    // The Usage tab has the full error and a way to read again.
    expect(screen.getByTestId('usage-tab').textContent).toContain(
      "Could not read this run's usage: database is locked"
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(skeletons(container)).toBe(0);
  });

  it('opens the Usage tab from the header Storage field', async () => {
    vi.mocked(fetchRunUsage).mockResolvedValue(failure('locked'));
    const onOpenUsage = vi.fn();
    function Header() {
      const state = useRunUsage(env, 'wrun_a');
      return (
        <RunUsageHeaderStats
          usage={state.usage ?? undefined}
          error={state.error}
          onOpenUsage={onOpenUsage}
        />
      );
    }
    render(<Header />);
    await waitFor(() =>
      expect(screen.getByTestId('run-usage-storage').textContent).toBe('—')
    );
    fireEvent.click(screen.getByTestId('run-usage-storage'));
    expect(onOpenUsage).toHaveBeenCalledTimes(1);
  });

  it('recovers with "Try again" in the header and the tab', async () => {
    vi.mocked(fetchRunUsage)
      .mockResolvedValueOnce(failure('database is locked'))
      .mockResolvedValueOnce(ok(usage(1234)));
    render(<RunPageUsage live={false} />);
    const retry = await screen.findByRole('button', { name: 'Try again' });

    await act(async () => {
      fireEvent.click(retry);
    });

    await waitFor(() =>
      expect(screen.getByTestId('run-usage-events').textContent).toBe('1,234')
    );
    expect(screen.getByTestId('run-usage-storage').textContent).toBe('2 KB');
    expect(screen.getByTestId('run-usage-summary').textContent).toBe(
      '1,234 events · 0 retries'
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
  });

  it('disables "Try again" while the read is in flight', async () => {
    const second = pending();
    vi.mocked(fetchRunUsage)
      .mockResolvedValueOnce(failure('locked'))
      .mockReturnValueOnce(second.promise);
    render(<RunPageUsage live={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    const busy = await screen.findByRole('button', {
      name: 'Trying again…',
    });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      second.resolve(ok(usage(5)));
    });
    await waitFor(() =>
      expect(screen.getByTestId('run-usage-events').textContent).toBe('5')
    );
  });
});

describe('a run that finished before the page read it', () => {
  it('reads the usage again until it is complete', async () => {
    vi.useFakeTimers();
    // The usage read was taken mid-run; the page reads the run as finished,
    // so it is never live.
    vi.mocked(fetchRunUsage)
      .mockResolvedValueOnce(ok(usage(4, 'running')))
      .mockResolvedValue(ok(usage(7, 'completed')));
    render(<RunPageUsage live={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('run-usage-events').textContent).toBe('4');
    expect(screen.getByTestId('usage-tab').textContent).toContain(
      'its usage can still grow'
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId('run-usage-events').textContent).toBe('7');
    expect(screen.getByTestId('usage-tab').textContent).not.toContain(
      'its usage can still grow'
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
  });
});

describe('unchanged paths', () => {
  it('hides the fields and the tab on a World without usage', async () => {
    vi.mocked(fetchRunUsage).mockResolvedValue(ok(null));
    const { container } = render(<RunPageUsage live={false} />);
    await waitFor(() => expect(fetchRunUsage).toHaveBeenCalled());
    await act(async () => {});
    expect(container.innerHTML).toBe('');
  });

  it('shows nothing before the first read on a backend that is not local', async () => {
    const first = pending();
    vi.mocked(fetchRunUsage).mockReturnValue(first.promise);
    const { container } = render(
      <RunPageUsage live={false} isLocalBackend={false} />
    );
    expect(container.innerHTML).toBe('');
    await act(async () => first.resolve(ok(null)));
    expect(container.innerHTML).toBe('');
  });

  it('shows placeholders while the first read is pending', async () => {
    const first = pending();
    vi.mocked(fetchRunUsage).mockReturnValue(first.promise);
    render(<RunPageUsage live={false} />);
    expect(skeletons(screen.getByTestId('header'))).toBe(2);
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await act(async () => first.resolve(ok(usage(3))));
    expect(screen.getByTestId('run-usage-events').textContent).toBe('3');
  });

  it('keeps the last numbers when a later poll of a live run fails', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchRunUsage)
      .mockResolvedValueOnce(ok(usage(40, 'running')))
      .mockResolvedValue(failure('database is locked'));
    render(<RunPageUsage live />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('run-usage-events').textContent).toBe('40');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchRunUsage).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('run-usage-events').textContent).toBe('40');
    expect(screen.getByTestId('run-usage-storage').textContent).toBe('2 KB');
    expect(screen.getByTestId('usage-tab').textContent).toContain(
      'Showing the last numbers read; refreshing failed: database is locked'
    );
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
