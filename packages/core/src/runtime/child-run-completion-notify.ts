import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
} from '@workflow/errors';
import type { WorkflowRunWithoutData, World } from '@workflow/world';
import { isRetryableWorldError } from '../classify-error.js';
import { runtimeLogger } from '../logger.js';
import {
  CHILD_RUN_COMPLETION_CONTEXT_KEY,
  type ChildRunCompletionPayload,
  childRunCompletionToken,
} from './child-run-completion.js';
import { resumeHookOnWorld } from './resume-hook.js';

/**
 * Backoff between attempts to resume a parent's completion hook after a
 * transient failure. The parent stays suspended until a resume lands, so the
 * budget is generous: about ten seconds in total, spent only on failures.
 */
const NOTIFY_RETRY_DELAYS_MS = [250, 1_000, 3_000, 6_000] as const;

/**
 * Whether runs started from a workflow are stamped so their parent can await
 * them through the child-run completion hook. On by default; an explicit
 * `WORKFLOW_CHILD_RUN_COMPLETION_HOOK=0` (or `false`) stops new runs from
 * being stamped, so their parents fall back to polling `returnValue` inside
 * a step. Runs already stamped keep notifying their parents either way.
 *
 * @internal
 */
export function isChildRunCompletionHookEnabled(): boolean {
  const raw = process.env.WORKFLOW_CHILD_RUN_COMPLETION_HOOK;
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw.toLowerCase() === 'false');
}

/** Whether a run was stamped to resume its parent's completion hook. */
export function notifiesParentOnCompletion(
  executionContext: Record<string, unknown> | undefined
): boolean {
  return executionContext?.[CHILD_RUN_COMPLETION_CONTEXT_KEY] === true;
}

type NotifiableRun = Pick<WorkflowRunWithoutData, 'runId' | 'executionContext'>;

/**
 * Resumes the completion hook of the parent waiting on `run`, if `run` was
 * started from a workflow. Call it after the run's terminal event is
 * written: the parent reads the run once after registering its hook, so a
 * resume that finds no hook is only safe once the read would see the run as
 * finished.
 *
 * Accepts the run itself when the caller already has it loaded, or its id
 * (read here, metadata only) on paths that do not.
 *
 * Never throws. A hook that does not exist is the common case (the parent
 * has not awaited the child yet, never will, or already finished) and is not
 * an error. Transient World failures are retried with backoff; anything that
 * still fails is logged.
 */
export async function notifyParentOfRunCompletion(
  world: World,
  run: NotifiableRun | string,
  status: ChildRunCompletionPayload['status']
): Promise<void> {
  const runId = typeof run === 'string' ? run : run.runId;
  try {
    const loaded =
      typeof run === 'string'
        ? await world.runs.get(run, { resolveData: 'none' })
        : run;
    if (!notifiesParentOnCompletion(loaded.executionContext)) return;

    const token = childRunCompletionToken(runId);
    const payload: ChildRunCompletionPayload = { status };
    for (let attempt = 0; ; attempt++) {
      try {
        await resumeHookOnWorld(world, token, payload);
        return;
      } catch (err) {
        if (
          HookNotFoundError.is(err) ||
          EntityConflictError.is(err) ||
          RunExpiredError.is(err)
        ) {
          // No parent is waiting (yet, or any longer): its read will see this
          // run's terminal state instead.
          return;
        }
        const delay = NOTIFY_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isRetryableWorldError(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } catch (err) {
    runtimeLogger.error(
      'Failed to resume the parent workflow waiting on this run. The parent stays suspended until the token is resumed, for example with resumeHook(token, { status }).',
      {
        workflowRunId: runId,
        token: childRunCompletionToken(runId),
        status,
        error: err instanceof Error ? err.message : String(err),
      }
    );
  }
}
