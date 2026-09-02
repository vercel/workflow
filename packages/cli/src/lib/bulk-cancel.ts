import { cancelRuns } from '@workflow/core/runtime';
import { parseWorkflowName } from '@workflow/utils/parse-name';
import type {
  BulkCancelWorkflowRunsResult,
  WorkflowRunStatus,
  World,
} from '@workflow/world';
import chalk from 'chalk';
import Table from 'easy-table';
import { planWindowStartFromResponse } from './inspect/time-window.js';

export const BULK_CANCEL_MIN_LIMIT = 1;
export const BULK_CANCEL_MAX_LIMIT = 500;
export const CLI_CANCEL_REASON = 'Cancelled via Workflow CLI';

/**
 * Statuses a run can still be cancelled from. When the caller doesn't pin a
 * `--status`, bulk cancel restricts matching to these so terminal runs
 * (including the ones a prior batch just cancelled) don't crowd out reachable
 * active runs. Otherwise, listing every status returns the same newest
 * terminal page on each rerun and older active runs are never reached. The
 * list API filters by a single status, so we fan out across these and merge.
 */
export const CANCELLABLE_STATUSES = [
  'pending',
  'running',
] as const satisfies readonly WorkflowRunStatus[];

/**
 * Guidance printed when more runs match the filters than were fetched. Bulk
 * cancel is deliberately single-batch and user-paced (no cursors or async
 * jobs), so the user re-runs to cancel the next batch.
 */
export const HAS_MORE_GUIDANCE =
  'More runs match these filters. Re-run this command to cancel the next batch,\n' +
  'or use --limit up to 500.';

export interface CancelLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Validate the `--limit` flag. Returns an error message when invalid, or
 * `undefined` when the value is an integer within [1, 500].
 */
export function validateBulkCancelLimit(limit: number): string | undefined {
  if (
    !Number.isInteger(limit) ||
    limit < BULK_CANCEL_MIN_LIMIT ||
    limit > BULK_CANCEL_MAX_LIMIT
  ) {
    return `--limit must be an integer between ${BULK_CANCEL_MIN_LIMIT} and ${BULK_CANCEL_MAX_LIMIT}.`;
  }
  return undefined;
}

/**
 * Build the compact multi-line "Done:" summary block. Lists every outcome
 * category so the counts add up to the number of runs requested; individual
 * `not_found`, `not_cancellable`, and `failed` runs are additionally surfaced
 * per-run via {@link bulkCancelFailureLines}.
 */
export function formatBulkCancelSummary(
  result: BulkCancelWorkflowRunsResult
): string {
  const { summary } = result;
  return [
    'Done:',
    `  ${summary.cancelled} cancelled`,
    `  ${summary.alreadyCancelled} already cancelled`,
    `  ${summary.notCancellable} not cancellable`,
    `  ${summary.notFound} not found`,
    `  ${summary.failed} failed`,
  ].join('\n');
}

/**
 * Per-run lines for outcomes worth calling out individually: `not_found`,
 * `not_cancellable`, and `failed`. Cancelled and already-cancelled runs are
 * left to the summary.
 */
export function bulkCancelFailureLines(
  result: BulkCancelWorkflowRunsResult
): string[] {
  const lines: string[] = [];
  for (const r of result.results) {
    switch (r.outcome) {
      case 'not_found':
        lines.push(`  ✗ ${r.runId}: not found`);
        break;
      case 'not_cancellable':
        lines.push(`  ✗ ${r.runId}: not cancellable (${r.status})`);
        break;
      case 'failed':
        lines.push(
          `  ✗ ${r.runId}: failed (${r.code}${r.retryable ? ', retryable' : ''})`
        );
        break;
    }
  }
  return lines;
}

export interface BulkCancelParams {
  world: World;
  status?: WorkflowRunStatus;
  workflowName?: string;
  /** Max runs to fetch and cancel in this batch (already validated). */
  limit: number;
  /** When true, skip the interactive confirmation prompt. */
  confirm: boolean;
  logger: CancelLogger;
  /**
   * Confirmation prompt. Omitted in non-interactive contexts (and tests),
   * in which case an unconfirmed run aborts.
   */
  promptConfirm?: (message: string) => Promise<boolean>;
}

export interface BulkCancelOutcome {
  /** Process exit code: 1 when any run failed, otherwise 0. */
  exitCode: number;
  /** The structured result, or undefined when nothing matched / aborted. */
  result?: BulkCancelWorkflowRunsResult;
}

/**
 * Resolve the plan's observability window from a one-row probe listing.
 *
 * Returns the `startTime`/`endTime` pair to bound subsequent listings with,
 * or `undefined` when the backend reports no window (nothing to widen to).
 * The probe needs a status because the list API takes one, but the window it
 * reads back is plan-wide, so any status will do.
 */
async function resolvePlanWindow(
  analytics: NonNullable<World['analytics']>,
  probeStatus: WorkflowRunStatus,
  workflowName: string | undefined
): Promise<{ startTime: string; endTime: string } | undefined> {
  const probe = await analytics.runs.list({
    status: probeStatus,
    workflowName,
    pagination: { limit: 1 },
  });
  const startTime = planWindowStartFromResponse(probe);
  return startTime
    ? { startTime, endTime: new Date().toISOString() }
    : undefined;
}

/**
 * Fetch matching runs (up to `limit`), confirm, and cancel them in a single
 * bulk operation. Prints a table of what will be cancelled, rerun guidance
 * when more runs match than were fetched, a compact summary, and per-run
 * lines for surfaced failures.
 *
 * Does not traverse pages: exactly one page of at most `limit` runs is
 * cancelled per invocation.
 */
export async function performBulkCancel(
  params: BulkCancelParams
): Promise<BulkCancelOutcome> {
  const { world, status, workflowName, limit, confirm, logger, promptConfirm } =
    params;

  // Fetch matching runs. Only metadata is needed to display and cancel, so
  // prefer the analytics read path when the backend provides one.
  //
  // When the caller pins a status, match exactly that. Otherwise restrict to
  // the cancellable statuses so rerunning makes progress instead of returning
  // the same terminal page forever. The list API takes a single status, so
  // fan out across the target statuses and merge the pages below.
  const analytics = world.analytics;
  const targetStatuses: WorkflowRunStatus[] = status
    ? [status]
    : [...CANCELLABLE_STATUSES];

  // The analytics backend defaults its listing to a recent window (trailing
  // 24h on the Vercel backend), but bulk cancel must match across the plan's
  // whole observability window: a run can sleep or wait on a hook for days
  // without emitting recent events. Probe once for the window bounds, then
  // match across them.
  //
  // The window is a property of the plan, not of a run's status, so the probe
  // is hoisted above the per-status fan-out. Running it inside meant a
  // four-status cancel issued four identical probes.
  const listingWindow = analytics
    ? await resolvePlanWindow(analytics, targetStatuses[0], workflowName)
    : undefined;

  const fetchPage = async (pageStatus: WorkflowRunStatus) => {
    if (!analytics) {
      return world.runs.list({
        status: pageStatus,
        workflowName,
        pagination: { limit },
        resolveData: 'none',
      });
    }
    return analytics.runs.list({
      status: pageStatus,
      workflowName,
      ...(listingWindow ?? {}),
      pagination: { limit },
    });
  };

  const pages = await Promise.all(targetStatuses.map(fetchPage));

  // Merge the per-status pages round-robin so a full page of running runs
  // cannot crowd pending runs (which do not have a startedAt timestamp) out
  // of every batch. Preserve each page's backend order and dedupe by runId in
  // case a run changes status while the pages are fetched.
  const projectedPages = pages.map((page) =>
    page.data.map((run) => ({
      runId: run.runId,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: run.startedAt,
    }))
  );
  const merged: (typeof projectedPages)[number][number][] = [];
  const seenRunIds = new Set<string>();
  const maxPageLength = Math.max(
    0,
    ...projectedPages.map((page) => page.length)
  );
  for (let index = 0; index < maxPageLength; index++) {
    for (const page of projectedPages) {
      const run = page[index];
      if (run && !seenRunIds.has(run.runId)) {
        seenRunIds.add(run.runId);
        merged.push(run);
      }
    }
  }
  const runs = {
    data: merged.slice(0, limit),
    hasMore: pages.some((page) => page.hasMore) || merged.length > limit,
  };

  if (runs.data.length === 0) {
    logger.warn('No matching runs found.');
    return { exitCode: 0 };
  }

  // Display what will be cancelled.
  const table = new Table();
  for (const run of runs.data) {
    const shortName =
      parseWorkflowName(run.workflowName)?.shortName || run.workflowName;
    table.cell('runId', run.runId);
    table.cell('workflow', chalk.blueBright(shortName));
    table.cell('status', run.status);
    table.cell(
      'startedAt',
      run.startedAt ? new Date(run.startedAt).toISOString() : '-'
    );
    table.newRow();
  }
  logger.log(`\nFound ${chalk.bold(runs.data.length)} runs to cancel:\n`);
  logger.log(table.toString());

  if (runs.hasMore) {
    logger.warn(HAS_MORE_GUIDANCE);
  }

  // Confirm unless --confirm/-y.
  if (!confirm) {
    const confirmed = promptConfirm
      ? await promptConfirm(
          `Cancel ${runs.data.length} run${runs.data.length === 1 ? '' : 's'}?`
        )
      : false;
    if (!confirmed) {
      logger.log('Aborted.');
      return { exitCode: 0 };
    }
  }

  // One bulk operation: a single backend request on Vercel, or bounded
  // fallback concurrency on local / community worlds.
  const result = await cancelRuns(
    world,
    runs.data.map((run) => run.runId),
    { cancelReason: CLI_CANCEL_REASON }
  );

  for (const line of bulkCancelFailureLines(result)) {
    logger.warn(line);
  }
  logger.log(`\n${formatBulkCancelSummary(result)}`);

  // Already-cancelled and terminal runs are valid partial outcomes; only a
  // genuine failure is a nonzero exit.
  return { exitCode: result.summary.failed > 0 ? 1 : 0, result };
}
