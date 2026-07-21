import fs from 'node:fs/promises';
import { RunExpiredError } from '@workflow/errors';
import type { Event, EventResult, WorkflowRun } from '@workflow/world';
import {
  SPEC_VERSION_CURRENT,
  isTerminalWorkflowRunStatus,
} from '@workflow/world';
import { DEFAULT_RESOLVE_DATA_OPTION } from '../config.js';
import {
  assertSafeEntityId,
  jsonReplacer,
  promoteExclusive,
  resolveWithinBase,
  writeExclusive,
  writeJSON,
} from '../fs.js';
import { filterRunData, stripEventDataRefs } from './filters.js';
import {
  isRunTerminalCommitted,
  monotonicUlid,
  pendingHookEventPath,
  reapPendingHookEvents,
  runTerminalMarkerPath,
} from './helpers.js';
import { deleteAllHooksForRun } from './hooks-storage.js';

/**
 * Terminal-run guard + publish for a legacy `hook_received`, mirroring the
 * current-spec hook_received protocol in events-storage.ts: fast-path
 * rejection, then stage → re-check marker → promote, so a concurrent legacy
 * run_cancelled (which reaps staged events after committing its marker)
 * arbitrates atomically with this publish.
 */
async function publishLegacyHookReceived(
  basedir: string,
  runId: string,
  eventId: string,
  serializedEvent: string,
  eventPath: string,
  currentRun: WorkflowRun
): Promise<void> {
  if (
    isTerminalWorkflowRunStatus(currentRun.status) ||
    (await isRunTerminalCommitted(basedir, runId))
  ) {
    throw new RunExpiredError(
      `Workflow run "${runId}" is already in a terminal state`
    );
  }
  const stagedPath = pendingHookEventPath(basedir, runId, eventId);
  await writeExclusive(stagedPath, serializedEvent);
  try {
    if (await isRunTerminalCommitted(basedir, runId)) {
      throw new RunExpiredError(
        `Workflow run "${runId}" is already in a terminal state`
      );
    }
    const promoted = await promoteExclusive(stagedPath, eventPath);
    if (promoted !== 'linked') {
      // 'missing': a terminal transition reaped the staged file — the
      // atomic loss of the arbitration. 'exists' cannot happen for a
      // freshly generated ULID; treat it the same way rather than report
      // a publish that did not happen.
      throw new RunExpiredError(
        `Workflow run "${runId}" is already in a terminal state`
      );
    }
  } finally {
    // The staged path is not reader-visible; removing it is pure cleanup
    // on every outcome (already gone when reaped).
    await fs.unlink(stagedPath).catch(() => {});
  }
}

/**
 * Handle events for legacy runs (pre-event-sourcing, specVersion < 2).
 * Legacy runs use different behavior:
 * - run_cancelled: Skip event storage, directly update run
 * - wait_completed: Store event only (no entity mutation)
 * - hook_received: Store event only (hooks exist via old system, no entity mutation)
 * - Other events: Throw error (not supported for legacy runs)
 *
 * Legacy runs predate tags, so all marker / staging paths below are
 * untagged.
 */
export async function handleLegacyEvent(
  basedir: string,
  runId: string,
  data: any,
  currentRun: WorkflowRun,
  params?: { resolveData?: 'none' | 'all' }
): Promise<EventResult> {
  // Defense in depth: events.create already validates runId before routing
  // here, but handleLegacyEvent is exported and its signature doesn't
  // document that invariant. Validating locally keeps the guarantee in this
  // file.
  assertSafeEntityId('runId', runId);

  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;

  switch (data.eventType) {
    case 'run_cancelled': {
      // Legacy: Skip event storage, directly update run to cancelled.
      //
      // Commit the durable run-terminal marker and reap staged
      // hook_received events BEFORE the state write, exactly like the
      // current-spec terminal transitions in events-storage.ts, so a
      // concurrent legacy hook_received in another process is subject to
      // the same stage → check → promote arbitration.
      await writeExclusive(runTerminalMarkerPath(basedir, runId), '');
      await reapPendingHookEvents(basedir, runId);
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
        attributes: currentRun.attributes,
      };
      const runPath = resolveWithinBase(basedir, 'runs', `${runId}.json`);
      await writeJSON(runPath, run, { overwrite: true });
      await deleteAllHooksForRun(basedir, runId);
      // Return without event (legacy behavior skips event storage)
      // Type assertion: EventResult expects WorkflowRun, filterRunData may return WorkflowRunWithoutData
      return {
        event: undefined,
        run: filterRunData(run, resolveData) as WorkflowRun,
      };
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
      const eventPath = resolveWithinBase(
        basedir,
        'events',
        `${compositeKey}.json`
      );
      if (data.eventType === 'hook_received') {
        await publishLegacyHookReceived(
          basedir,
          runId,
          eventId,
          JSON.stringify(event, jsonReplacer, 2),
          eventPath,
          currentRun
        );
      } else {
        await writeJSON(eventPath, event);
      }
      return { event: stripEventDataRefs(event, resolveData) };
    }

    default:
      throw new Error(
        `Event type '${data.eventType}' not supported for legacy runs ` +
          `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
          `Please upgrade 'workflow' package.`
      );
  }
}
