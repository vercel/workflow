import type {
  BulkCancelWorkflowRunsRequest,
  BulkCancelWorkflowRunsResult,
  World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import {
  bulkCancelFailureLines,
  CLI_CANCEL_REASON,
  formatBulkCancelSummary,
  HAS_MORE_GUIDANCE,
  performBulkCancel,
  validateBulkCancelLimit,
} from './bulk-cancel.js';

interface FakeRun {
  runId: string;
  workflowName: string;
  status: string;
  startedAt?: string;
}

/** Collects logger output so assertions can inspect what the user saw. */
function makeLogger() {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    logger: {
      log: (m: string) => logs.push(m),
      warn: (m: string) => warns.push(m),
      error: (m: string) => errors.push(m),
    },
    logs,
    warns,
    errors,
  };
}

/**
 * Build a minimal fake world. `cancelMany` is attached only when provided,
 * which is how {@link performBulkCancel} (via `cancelRuns`) decides between
 * the single-request fast path and the per-run fallback.
 */
function makeWorld(opts: {
  runs: FakeRun[];
  hasMore?: boolean;
  cancelMany?: (
    request: BulkCancelWorkflowRunsRequest
  ) => Promise<BulkCancelWorkflowRunsResult>;
  eventsCreate?: (runId: string) => Promise<unknown>;
  /**
   * Attach an analytics namespace whose listings report a plan window, so a
   * test can exercise the probe-and-widen path. Left off by default: without
   * it `performBulkCancel` reads storage.
   */
  analyticsWindowStart?: string;
}): World {
  const runsById = new Map(opts.runs.map((r) => [r.runId, r]));
  const windowStart = opts.analyticsWindowStart;
  const analyticsList = windowStart
    ? vi.fn(async (params: { status?: string } = {}) => ({
        data: params.status
          ? opts.runs.filter((r) => r.status === params.status)
          : opts.runs,
        hasMore: opts.hasMore ?? false,
        pageInfo: {
          currentLookbackDays: 30,
          maxLookbackDays: 30,
          currentWindowStart: new Date(windowStart),
          maxWindowStart: new Date(windowStart),
          upgradeAvailable: false,
        },
      }))
    : undefined;
  const world: any = {
    analytics: analyticsList ? { runs: { list: analyticsList } } : undefined,
    runs: {
      // Status-aware so tests can seed mixed-status runs and assert that only
      // the requested status is matched. performBulkCancel always passes a
      // concrete status per call (the pinned one, or each cancellable status).
      list: vi.fn(async (params: { status?: string } = {}) => ({
        data: params.status
          ? opts.runs.filter((r) => r.status === params.status)
          : opts.runs,
        hasMore: opts.hasMore ?? false,
      })),
      get: vi.fn(async (runId: string) => {
        const run = runsById.get(runId);
        if (!run) throw new Error(`run ${runId} not found`);
        return run;
      }),
    },
    events: {
      create: vi.fn(async (runId: string) => opts.eventsCreate?.(runId)),
    },
  };
  if (opts.cancelMany) {
    world.runs.cancelMany = vi.fn(opts.cancelMany);
  }
  return world as World;
}

describe('validateBulkCancelLimit', () => {
  it('accepts integers within [1, 500]', () => {
    expect(validateBulkCancelLimit(1)).toBeUndefined();
    expect(validateBulkCancelLimit(50)).toBeUndefined();
    expect(validateBulkCancelLimit(500)).toBeUndefined();
  });

  it('rejects out-of-range and non-integer values', () => {
    expect(validateBulkCancelLimit(0)).toMatch(/between 1 and 500/);
    expect(validateBulkCancelLimit(501)).toMatch(/between 1 and 500/);
    expect(validateBulkCancelLimit(-5)).toMatch(/between 1 and 500/);
    expect(validateBulkCancelLimit(1.5)).toMatch(/between 1 and 500/);
  });
});

describe('formatBulkCancelSummary', () => {
  it('renders every outcome category so counts add up to requested', () => {
    const summary = formatBulkCancelSummary({
      summary: {
        requested: 7,
        cancelled: 2,
        alreadyCancelled: 1,
        notCancellable: 1,
        notFound: 3,
        failed: 0,
      },
      results: [],
    });
    expect(summary).toBe(
      [
        'Done:',
        '  2 cancelled',
        '  1 already cancelled',
        '  1 not cancellable',
        '  3 not found',
        '  0 failed',
      ].join('\n')
    );
  });
});

describe('bulkCancelFailureLines', () => {
  it('surfaces only not_found, not_cancellable, and failed runs', () => {
    const lines = bulkCancelFailureLines({
      summary: {
        requested: 5,
        cancelled: 1,
        alreadyCancelled: 1,
        notCancellable: 1,
        notFound: 1,
        failed: 1,
      },
      results: [
        { runId: 'a', outcome: 'cancelled' },
        { runId: 'b', outcome: 'already_cancelled' },
        { runId: 'c', outcome: 'not_cancellable', status: 'completed' },
        { runId: 'd', outcome: 'not_found' },
        {
          runId: 'e',
          outcome: 'failed',
          code: 'internal_error',
          retryable: true,
        },
      ],
    });
    expect(lines).toEqual([
      '  ✗ c: not cancellable (completed)',
      '  ✗ d: not found',
      '  ✗ e: failed (internal_error, retryable)',
    ]);
  });
});

describe('performBulkCancel', () => {
  it('warns and exits 0 when no runs match', async () => {
    const { logger, warns } = makeLogger();
    const world = makeWorld({ runs: [] });

    const { exitCode, result } = await performBulkCancel({
      world,
      limit: 50,
      confirm: true,
      logger,
    });

    expect(exitCode).toBe(0);
    expect(result).toBeUndefined();
    expect(warns).toContain('No matching runs found.');
  });

  it('restricts to cancellable statuses and excludes terminal runs when no status is pinned', async () => {
    const { logger } = makeLogger();
    const cancelMany = vi.fn(
      async (
        req: BulkCancelWorkflowRunsRequest
      ): Promise<BulkCancelWorkflowRunsResult> => ({
        summary: {
          requested: req.runIds.length,
          cancelled: req.runIds.length,
          alreadyCancelled: 0,
          notCancellable: 0,
          notFound: 0,
          failed: 0,
        },
        results: req.runIds.map((runId) => ({
          runId,
          outcome: 'cancelled' as const,
        })),
      })
    );
    const world = makeWorld({
      runs: [
        { runId: 'p1', workflowName: 'wf', status: 'pending' },
        { runId: 'r1', workflowName: 'wf', status: 'running' },
        // Terminal — must never be fetched or cancelled.
        { runId: 'done', workflowName: 'wf', status: 'completed' },
      ],
      cancelMany,
    });

    const { exitCode } = await performBulkCancel({
      world,
      limit: 50,
      confirm: true,
      logger,
    });

    expect(exitCode).toBe(0);
    const requestedStatuses = (world.runs.list as any).mock.calls.map(
      (c: [{ status?: string }]) => c[0]?.status
    );
    expect(requestedStatuses).toContain('pending');
    expect(requestedStatuses).toContain('running');
    expect(requestedStatuses).not.toContain('completed');
    // Only the cancellable runs reach cancelMany; the completed run is excluded.
    expect(cancelMany).toHaveBeenCalledTimes(1);
    expect([...cancelMany.mock.calls[0][0].runIds].sort()).toEqual([
      'p1',
      'r1',
    ]);
  });

  it('round-robins status pages before applying the batch limit', async () => {
    const { logger } = makeLogger();
    const cancelMany = vi.fn(
      async (
        req: BulkCancelWorkflowRunsRequest
      ): Promise<BulkCancelWorkflowRunsResult> => ({
        summary: {
          requested: req.runIds.length,
          cancelled: req.runIds.length,
          alreadyCancelled: 0,
          notCancellable: 0,
          notFound: 0,
          failed: 0,
        },
        results: req.runIds.map((runId) => ({
          runId,
          outcome: 'cancelled' as const,
        })),
      })
    );
    const world = makeWorld({
      runs: [
        ...Array.from({ length: 5 }, (_, index) => ({
          runId: `r${index + 1}`,
          workflowName: 'wf',
          status: 'running',
          startedAt: new Date(2026, 0, index + 1).toISOString(),
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          runId: `p${index + 1}`,
          workflowName: 'wf',
          status: 'pending',
        })),
      ],
      cancelMany,
    });

    await performBulkCancel({
      world,
      limit: 5,
      confirm: true,
      logger,
    });

    expect(cancelMany).toHaveBeenCalledWith({
      runIds: ['p1', 'r1', 'p2', 'r2', 'p3'],
      cancelReason: CLI_CANCEL_REASON,
    });
  });

  it('uses the cancelMany fast path in a single call and skips per-run events', async () => {
    const { logger } = makeLogger();
    const cancelMany = vi.fn(
      async (): Promise<BulkCancelWorkflowRunsResult> => ({
        summary: {
          requested: 2,
          cancelled: 2,
          alreadyCancelled: 0,
          notCancellable: 0,
          notFound: 0,
          failed: 0,
        },
        results: [
          { runId: 'r1', outcome: 'cancelled' },
          { runId: 'r2', outcome: 'cancelled' },
        ],
      })
    );
    const world = makeWorld({
      runs: [
        { runId: 'r1', workflowName: 'wf', status: 'running' },
        { runId: 'r2', workflowName: 'wf', status: 'running' },
      ],
      cancelMany,
    });

    const { exitCode } = await performBulkCancel({
      world,
      status: 'running',
      limit: 50,
      confirm: true,
      logger,
    });

    expect(exitCode).toBe(0);
    expect(cancelMany).toHaveBeenCalledTimes(1);
    expect(cancelMany).toHaveBeenCalledWith({
      runIds: ['r1', 'r2'],
      cancelReason: CLI_CANCEL_REASON,
    });
    // Fast path must not fall back to per-run event creation.
    expect(world.events.create as any).not.toHaveBeenCalled();
  });

  it('falls back to per-run cancellation when cancelMany is absent', async () => {
    const { logger, logs } = makeLogger();
    const world = makeWorld({
      runs: [
        { runId: 'r1', workflowName: 'wf', status: 'running' },
        { runId: 'r2', workflowName: 'wf', status: 'running' },
      ],
    });

    const { exitCode, result } = await performBulkCancel({
      world,
      status: 'running',
      limit: 50,
      confirm: true,
      logger,
    });

    expect(exitCode).toBe(0);
    expect(world.events.create as any).toHaveBeenCalledTimes(2);
    expect(world.events.create as any).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({
        eventData: { cancelReason: CLI_CANCEL_REASON },
      }),
      expect.anything()
    );
    expect(result?.summary.cancelled).toBe(2);
    expect(logs.join('\n')).toContain('2 cancelled');
  });

  it('prints rerun guidance when more runs match than were fetched', async () => {
    const { logger, warns } = makeLogger();
    const world = makeWorld({
      runs: [{ runId: 'r1', workflowName: 'wf', status: 'running' }],
      hasMore: true,
      cancelMany: async () => ({
        summary: {
          requested: 1,
          cancelled: 1,
          alreadyCancelled: 0,
          notCancellable: 0,
          notFound: 0,
          failed: 0,
        },
        results: [{ runId: 'r1', outcome: 'cancelled' }],
      }),
    });

    await performBulkCancel({
      world,
      status: 'running',
      limit: 1,
      confirm: true,
      logger,
    });

    expect(warns).toContain(HAS_MORE_GUIDANCE);
  });

  it('exits 1 and surfaces per-run failures when a run fails', async () => {
    const { logger, warns } = makeLogger();
    const world = makeWorld({
      runs: [
        { runId: 'r1', workflowName: 'wf', status: 'running' },
        { runId: 'r2', workflowName: 'wf', status: 'running' },
      ],
      cancelMany: async () => ({
        summary: {
          requested: 2,
          cancelled: 1,
          alreadyCancelled: 0,
          notCancellable: 0,
          notFound: 0,
          failed: 1,
        },
        results: [
          { runId: 'r1', outcome: 'cancelled' },
          {
            runId: 'r2',
            outcome: 'failed',
            code: 'internal_error',
            retryable: true,
          },
        ],
      }),
    });

    const { exitCode } = await performBulkCancel({
      world,
      status: 'running',
      limit: 50,
      confirm: true,
      logger,
    });

    expect(exitCode).toBe(1);
    expect(warns).toContain('  ✗ r2: failed (internal_error, retryable)');
  });

  it('aborts without cancelling when confirmation is declined', async () => {
    const { logger, logs } = makeLogger();
    const cancelMany = vi.fn();
    const world = makeWorld({
      runs: [{ runId: 'r1', workflowName: 'wf', status: 'running' }],
      cancelMany: cancelMany as any,
    });

    const { exitCode } = await performBulkCancel({
      world,
      status: 'running',
      limit: 50,
      confirm: false,
      logger,
      promptConfirm: async () => false,
    });

    expect(exitCode).toBe(0);
    expect(logs).toContain('Aborted.');
    expect(cancelMany).not.toHaveBeenCalled();
  });
});

describe('performBulkCancel analytics window probe', () => {
  it('probes the plan window once for the whole status fan-out', async () => {
    const windowStart = '2026-08-03T00:00:00.000Z';
    const cancelMany = async (
      req: BulkCancelWorkflowRunsRequest
    ): Promise<BulkCancelWorkflowRunsResult> => ({
      summary: {
        requested: req.runIds.length,
        cancelled: req.runIds.length,
        alreadyCancelled: 0,
        notCancellable: 0,
        notFound: 0,
        failed: 0,
      },
      results: req.runIds.map((runId) => ({
        runId,
        outcome: 'cancelled' as const,
      })),
    });
    const world = makeWorld({
      analyticsWindowStart: windowStart,
      runs: [
        { runId: 'p1', workflowName: 'wf', status: 'pending' },
        { runId: 'r1', workflowName: 'wf', status: 'running' },
      ],
      cancelMany,
    });
    const { logger } = makeLogger();

    const { exitCode } = await performBulkCancel({
      world,
      limit: 50,
      confirm: true,
      logger,
    });

    expect(exitCode).toBe(0);
    const calls = (world.analytics?.runs.list as any).mock.calls.map(
      (
        c: [
          {
            status?: string;
            startTime?: string;
            pagination?: { limit?: number };
          },
        ]
      ) => c[0]
    );

    // Exactly one probe, regardless of how many statuses are fanned out.
    const probes = calls.filter(
      (c: { pagination?: { limit?: number } }) => c.pagination?.limit === 1
    );
    expect(probes).toHaveLength(1);

    // Every real listing is bounded by the window the probe resolved.
    const listings = calls.filter(
      (c: { pagination?: { limit?: number } }) => c.pagination?.limit !== 1
    );
    expect(listings.length).toBeGreaterThan(1);
    for (const listing of listings) {
      expect(listing.startTime).toBe(windowStart);
      expect(listing.endTime).toBeDefined();
    }
    // Storage is not consulted when analytics is available.
    expect(world.runs.list).not.toHaveBeenCalled();
  });
});
