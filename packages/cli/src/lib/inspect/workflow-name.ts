import { parseWorkflowName } from '@workflow/utils/parse-name';
import type { World } from '@workflow/world';
import { logger } from '../config/log.js';

/** Runs fetched per page while looking for a short name. */
const SCAN_PAGE_SIZE = 100;

/**
 * Pages scanned at most: the 500 most recent runs. A short name only needs
 * one run of its workflow to resolve, so this bounds the extra requests a
 * short name costs without missing any workflow that ran recently.
 */
const SCAN_MAX_PAGES = 5;

export interface ResolveWorkflowNameOptions {
  /**
   * Scan the analytics read path, as the listing reads it. False means
   * storage: the backend has no analytics, or `--withData` moved the
   * listing off it.
   */
  useAnalytics: boolean;
  /** The listing's `--since`/`--until` window, which only analytics takes. */
  timeWindow?: { startTime: string; endTime: string };
}

/**
 * Resolve `--workflowName` to the full name the backends filter on.
 *
 * Every World matches `workflowName` exactly, against the generated name
 * (`workflow//./src/jobs/order//processOrder`), while the runs table shows
 * the short name (`processOrder`), so the value a user copied from the table
 * matched nothing.
 *
 * A full name passes through with no extra request. Anything else is
 * matched against the short and function names of the most recent runs'
 * workflows, read the way the listing reads them:
 * - one workflow matches: its full name is used, and the resolution logged;
 * - several match (the same export in two modules, or under two dynamic
 *   workflow names): throws with the candidates, since either answer could
 *   be the wrong one;
 * - none match: the value passes through unchanged with a warning, so a name
 *   that only looks short, or a workflow that has not run recently, behaves
 *   as before.
 */
export async function resolveWorkflowNameFilter(
  world: World,
  workflowName: string | undefined,
  options: ResolveWorkflowNameOptions
): Promise<string | undefined> {
  if (!workflowName || parseWorkflowName(workflowName)) {
    return workflowName;
  }

  const candidates = await findWorkflowNames(world, workflowName, options);

  if (candidates.length === 1) {
    logger.info(
      `Filtering by workflow ${candidates[0]}, the one recent workflow named ${JSON.stringify(workflowName)}.`
    );
    return candidates[0];
  }
  if (candidates.length > 1) {
    throw new Error(
      `--workflowName ${JSON.stringify(workflowName)} names ${candidates.length} workflows in recent runs: ${candidates.join(', ')}. Pass the full name of one.`
    );
  }
  logger.warn(
    `No recent run's workflow is named ${JSON.stringify(workflowName)}; filtering by it as a full workflow name, such as workflow//./src/jobs/order//processOrder.`
  );
  return workflowName;
}

const matchesShortName = (name: string, value: string): boolean => {
  const parsed = parseWorkflowName(name);
  return (
    parsed !== null &&
    (parsed.shortName === value || parsed.functionName === value)
  );
};

async function findWorkflowNames(
  world: World,
  value: string,
  { useAnalytics, timeWindow }: ResolveWorkflowNameOptions
): Promise<string[]> {
  const found = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const pagination = {
      sortOrder: 'desc' as const,
      cursor,
      limit: SCAN_PAGE_SIZE,
    };
    const runs =
      useAnalytics && world.analytics
        ? await world.analytics.runs.list({
            ...(timeWindow ?? {}),
            pagination,
          })
        : await world.runs.list({ pagination, resolveData: 'none' });
    for (const run of runs.data) {
      if (matchesShortName(run.workflowName, value)) {
        found.add(run.workflowName);
      }
    }
    if (!runs.hasMore || !runs.cursor) break;
    cursor = runs.cursor;
  }
  return [...found].sort();
}
