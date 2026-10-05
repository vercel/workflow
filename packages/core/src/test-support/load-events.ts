import type { World } from '@workflow/world';
import type { LoadedEventLog } from '../runtime/helpers.js';
import { REPLAY_RESOLVE_DATA } from '../runtime/helpers.js';

/**
 * A full log load against an explicit World, keeping the first page's
 * snapshot, for tests that do not install a global World.
 */
export async function loadWorkflowRunEventsFrom(
  world: Pick<World, 'events'>,
  runId: string
): Promise<LoadedEventLog> {
  const events: LoadedEventLog['events'] = [];
  let cursor: string | null = null;
  let snapshot: LoadedEventLog['snapshot'];
  let first = true;
  let hasMore = true;
  while (hasMore) {
    const page = await world.events.list({
      runId,
      pagination: { sortOrder: 'asc', cursor: cursor ?? undefined },
      resolveData: REPLAY_RESOLVE_DATA,
    });
    if (first) snapshot = page.snapshot;
    first = false;
    events.push(...page.data);
    cursor = page.cursor ?? cursor;
    hasMore = page.hasMore;
  }
  return { events, cursor, snapshot };
}
