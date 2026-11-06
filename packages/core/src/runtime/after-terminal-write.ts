import type { WorkflowRunWithoutData, World } from '@workflow/world';
import type { PayloadKey } from '../serialization/encryption.js';
import { notifyParentOfRunCompletion } from './child-run-completion-notify.js';
import {
  dispatchRunCompletedHooks,
  dispatchRunFailedHooks,
} from './lifecycle-hooks.js';

/**
 * What every writer of a run's terminal event owes once the World recorded
 * it: the run's lifecycle hooks, and the completion hook of the parent that
 * started it, which may be suspended waiting on this run.
 *
 * Terminal events are written from many places (each engine's completion and
 * failure paths, fatal setup errors, max deliveries, replay timeout,
 * deployment mismatch, cancellation), so these are the only entry points: a
 * new terminal path that calls one of them cannot dispatch the lifecycle
 * hooks and forget the parent. `after-terminal-write.test.ts` fails on a
 * direct `dispatchRun*Hooks` call anywhere else.
 *
 * Call them only after the write succeeded: a parent that finds no
 * notification reads the child after registering its hook, and that read
 * must see the terminal event. None of them throws.
 */

/** The run as the caller has it (preferred, no read), or just its id. */
type TerminalRun =
  | Pick<WorkflowRunWithoutData, 'runId' | 'executionContext'>
  | string;

const runIdOf = (run: TerminalRun) =>
  typeof run === 'string' ? run : run.runId;

/** After a `run_completed` write. */
export async function afterRunCompleted(
  world: World,
  run: TerminalRun,
  workflowName: string
): Promise<void> {
  dispatchRunCompletedHooks(runIdOf(run), workflowName);
  await notifyParentOfRunCompletion(world, run, 'completed');
}

/**
 * After a `run_failed` write.
 *
 * @param error - The serialized error payload stored by the terminal write.
 * @param errorCode - The classification written to the event's `errorCode`.
 */
export async function afterRunFailed(
  world: World,
  run: TerminalRun,
  workflowName: string,
  error: unknown,
  encryptionKey: PayloadKey | undefined,
  errorCode: string
): Promise<void> {
  dispatchRunFailedHooks(
    runIdOf(run),
    workflowName,
    error,
    encryptionKey,
    errorCode
  );
  await notifyParentOfRunCompletion(world, run, 'failed');
}

/** After a `run_cancelled` write. Cancellation has no lifecycle hooks. */
export async function afterRunCancelled(
  world: World,
  run: TerminalRun
): Promise<void> {
  await notifyParentOfRunCompletion(world, run, 'cancelled');
}
