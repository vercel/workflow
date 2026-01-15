import path from 'node:path';
import type { Event, EventResult, WorkflowRun } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import { writeJSON } from '../fs.js';
import { filterEventData, filterRunData } from './filters.js';
import { monotonicUlid } from './helpers.js';
import { deleteAllHooksForRun } from './hooks-storage.js';

/**
 * Handle events for legacy runs (pre-event-sourcing, specVersion < 2).
 * Legacy runs use different behavior:
 * - run_cancelled: Skip event storage, directly update run
 * - wait_completed: Store event only (no entity mutation)
 * - hook_received: Store event only (hooks exist via old system, no entity mutation)
 * - Other events: Throw error (not supported for legacy runs)
 */
export async function handleLegacyEvent(
  basedir: string,
  runId: string,
  data: any,
  currentRun: WorkflowRun,
  params?: { resolveData?: 'none' | 'all' }
): Promise<EventResult> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;

  switch (data.eventType) {
    case 'run_cancelled': {
      // Legacy: Skip event storage, directly update run to cancelled
      const now = new Date();
      const run: WorkflowRun = {
        runId: currentRun.runId,
        deploymentId: currentRun.deploymentId,
        workflowName: currentRun.workflowName,
        specVersion: currentRun.specVersion,
        executionContext: currentRun.executionContext,
        input: currentRun.input,
        createdAt: currentRun.createdAt,
        expiredAt: currentRun.expiredAt,
        startedAt: currentRun.startedAt,
        status: 'cancelled',
        output: undefined,
        error: undefined,
        completedAt: now,
        updatedAt: now,
      };
      const runPath = path.join(basedir, 'runs', `${runId}.json`);
      await writeJSON(runPath, run, { overwrite: true });
      await deleteAllHooksForRun(basedir, runId);
      // Return without event (legacy behavior skips event storage)
      return { event: undefined, run: filterRunData(run, resolveData) };
    }

    case 'wait_completed':
    case 'hook_received': {
      // Legacy: Store event only (no entity mutation)
      // - wait_completed: for replay purposes
      // - hook_received: hooks exist via old system, just record the event
      const eventId = `evnt_${monotonicUlid()}`;
      const now = new Date();
      const event: Event = {
        ...data,
        runId,
        eventId,
        createdAt: now,
        specVersion: SPEC_VERSION_CURRENT,
      };
      const compositeKey = `${runId}-${eventId}`;
      const eventPath = path.join(basedir, 'events', `${compositeKey}.json`);
      await writeJSON(eventPath, event);
      return { event: filterEventData(event, resolveData) };
    }

    default:
      throw new Error(
        `Event type '${data.eventType}' not supported for legacy runs ` +
          `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
          `Please upgrade @workflow packages.`
      );
  }
}
