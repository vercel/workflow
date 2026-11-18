/**
 * The run's Usage page as a route: `/run/:runId/usage`, a child of the run
 * page, rendered under the run's header by the real route config,
 * RunDetailView and route modules. Only the data hooks and the heavy
 * children (trace viewer, Events tab, actions) are stubbed.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { TooltipProvider } from '@workflow/web-shared';
import { buildRunUsage, type RunUsage } from '@workflow/world';
import {
  createMemoryRouter,
  matchRoutes,
  type RouteObject,
  RouterProvider,
} from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serverConfig = { backendId: 'local' };

vi.mock('~/lib/world-config-context', () => ({
  useServerConfig: () => ({ serverConfig }),
}));
vi.mock('~/lib/workflow-api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/workflow-api-client')>()),
  useWorkflowTraceViewerData: () => ({
    run: {
      runId: 'wrun_1',
      workflowName: 'workflow//./src/workflows/order//processOrder',
      status: 'completed',
      createdAt: new Date('2026-11-18T10:00:00Z'),
      startedAt: new Date('2026-11-18T10:00:01Z'),
      completedAt: new Date('2026-11-18T10:00:05Z'),
    },
    events: [],
    loading: false,
    error: null,
    update: vi.fn(),
    hasEncryptedData: false,
    loadMoreTraceData: vi.fn(),
    hasMoreTraceData: false,
    isLoadingMoreTraceData: false,
  }),
  useWorkflowStreams: () => ({ streams: [], loading: false, error: null }),
}));
vi.mock('~/lib/client/hooks/use-cancellation-reason', () => ({
  useCancellationReason: () => undefined,
}));
vi.mock('~/lib/hooks/use-stream-reader', () => ({
  useStreamReader: () => ({
    chunks: [],
    isLive: false,
    isInitialLoading: false,
    error: null,
  }),
}));
vi.mock('~/lib/rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/rpc-client')>()),
  fetchRunUsage: vi.fn(),
}));
vi.mock('@workflow/web-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workflow/web-shared')>()),
  TraceViewer: () => <div data-testid="trace-viewer" />,
}));
vi.mock('~/components/run-events-tab', () => ({
  RunEventsTab: () => <div data-testid="events-tab" />,
}));
vi.mock('~/components/run-actions', () => ({
  RunActionsButtons: () => null,
}));

import { fetchRunUsage } from '~/lib/rpc-client';
import { meta as rootMeta } from '~/root';
import routes from '~/routes';
import * as runDetailModule from './run-detail';
import * as runUsageModule from './run-usage';

const MODULES: Record<string, { default: () => React.ReactNode }> = {
  './routes/run-detail.tsx': runDetailModule,
  './routes/run-usage.tsx': runUsageModule,
};

interface ConfigEntry {
  path?: string;
  index?: boolean;
  file: string;
  children?: ConfigEntry[];
}

/** The app's route config as router route objects, keyed by module file. */
function toRouteObjects(entries: ConfigEntry[]): RouteObject[] {
  return entries.map((entry) => {
    const Component = MODULES[entry.file]?.default ?? (() => null);
    const base = { id: entry.file, Component };
    return entry.index
      ? { ...base, index: true }
      : {
          ...base,
          path: entry.path,
          children: entry.children && toRouteObjects(entry.children),
        };
  });
}

const routeObjects = toRouteObjects(routes as ConfigEntry[]);

const usage: RunUsage = buildRunUsage({
  runId: 'wrun_1',
  status: 'completed',
  workflowName: 'workflow//./src/workflows/order//processOrder',
  eventGroups: [
    { eventType: 'run_created', events: 1, bytes: 400 },
    { eventType: 'run_started', events: 1, bytes: 100 },
    { eventType: 'run_completed', events: 1, bytes: 300 },
  ],
  stepGroups: [
    {
      stepName: 'step//./src/workflows/order//chargeCard',
      steps: 1,
      events: 5,
      created: 1,
      started: 2,
      completed: 1,
      failed: 0,
      retries: 1,
      restarts: 1,
      bytes: 1200,
    },
  ],
  streamBytes: 0,
});

function renderAt(path: string) {
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  );
  return router;
}

beforeEach(() => {
  serverConfig.backendId = 'local';
  vi.mocked(fetchRunUsage).mockReset();
  vi.mocked(fetchRunUsage).mockResolvedValue({ success: true, data: usage });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(cleanup);

const matchedFiles = (path: string) =>
  matchRoutes(routeObjects, path)?.map((match) => match.route.id) ?? null;

describe('the Usage route', () => {
  it('is a child of the run page', () => {
    expect(matchedFiles('/run/wrun_1/usage')).toEqual([
      './routes/run-detail.tsx',
      './routes/run-usage.tsx',
    ]);
    expect(matchedFiles('/run/wrun_1')).toEqual(['./routes/run-detail.tsx']);
    expect(matchedFiles('/run/wrun_1/usage/more')).toBeNull();
    expect(matchedFiles('/run/wrun_1/events')).toBeNull();
  });

  it('titles the page with the run, and other pages keep the default', () => {
    expect(runUsageModule.meta({ params: { runId: 'wrun_1' } })[0]).toEqual({
      title: 'Usage · wrun_1 · Workflow Observability UI',
    });
    expect(rootMeta()[0]).toEqual({ title: 'Workflow Observability UI' });
  });

  it('opens from the run header, under the same header, without a second read', async () => {
    const router = renderAt('/run/wrun_1');
    const events = await screen.findByRole('link', {
      name: '8 events, open usage',
    });
    // The tabs, without a Usage tab.
    expect(screen.getByRole('tab', { name: 'Trace' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /usage/i })).toBeNull();
    expect(screen.queryByTestId('run-usage-page')).toBeNull();

    await act(async () => {
      fireEvent.click(events);
    });
    expect(router.state.location.pathname).toBe('/run/wrun_1/usage');
    await screen.findByTestId('run-usage-page');
    // The header stayed: its figures are text on their own page.
    expect(screen.getByRole('heading', { name: 'processOrder' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /open usage/ })).toBeNull();
    expect(screen.getByTestId('run-usage-events').textContent).toBe('8');
    // The tabs give way to the page.
    expect(screen.queryByRole('tab', { name: 'Trace' })).toBeNull();
    expect(screen.queryByTestId('trace-viewer')).toBeNull();
    // Kept mounted, the header's read serves the page.
    expect(fetchRunUsage).toHaveBeenCalledTimes(1);

    // The breadcrumb leads back to the run.
    expect(
      screen.getByText('Usage', { selector: '[aria-current="page"]' })
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'wrun_1' }));
    });
    expect(router.state.location.pathname).toBe('/run/wrun_1');
    await screen.findByRole('tab', { name: 'Trace' });
    expect(fetchRunUsage).toHaveBeenCalledTimes(1);
  });

  it('opens from Data written (local) too', async () => {
    const router = renderAt('/run/wrun_1');
    const data = await screen.findByRole('link', {
      name: /data written \(local\), open usage$/,
    });
    await act(async () => {
      fireEvent.click(data);
    });
    expect(router.state.location.pathname).toBe('/run/wrun_1/usage');
  });

  it('opened directly, it renders the page with the header', async () => {
    renderAt('/run/wrun_1/usage');
    await screen.findByTestId('run-usage-page');
    expect(screen.getByTestId('run-usage-data-label').textContent).toBe(
      'Data written (local)'
    );
  });

  it('on a World without usage, says so and hides the header fields', async () => {
    serverConfig.backendId = 'vercel';
    vi.mocked(fetchRunUsage).mockResolvedValue({ success: true, data: null });
    renderAt('/run/wrun_1/usage');
    await screen.findByTestId('run-usage-unsupported');
    expect(screen.queryByTestId('run-usage-events')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Back to run' }).getAttribute('href')
    ).toBe('/run/wrun_1');
  });

  it('keeps ?tab=usage on the run page showing the trace', async () => {
    renderAt('/run/wrun_1?tab=usage');
    await waitFor(() =>
      expect(
        screen.getByRole('tab', { name: 'Trace' }).getAttribute('aria-selected')
      ).toBe('true')
    );
    expect(screen.queryByTestId('run-usage-page')).toBeNull();
  });
});
