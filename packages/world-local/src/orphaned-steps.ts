import { EntityConflictError } from '@workflow/errors';
import {
  type Event,
  isStepEventType,
  SPEC_VERSION_CURRENT,
  type Storage,
} from '@workflow/world';

export const ORPHANED_STEP_ERROR_MESSAGE =
  'The process running this step exited before it finished.';

/**
 * Hand every step still inline-owned by a queue message of a previous process
 * back to the queue, by writing `step_retrying` for it.
 *
 * A step that runs inline records its queue message on `step_started`
 * (`ownerMessageId`), and until a lease expires, core defers to that owner
 * instead of dispatching the step again (vercel/workflow#2780). The local
 * queue is in memory, so after a restart no owner from the previous process
 * can still be alive or be redelivered, and recovery would wait out the whole
 * lease (vercel/workflow#4939). Core treats `step_retrying` as the permanent
 * end of inline ownership, so the replay dispatches the step at once.
 *
 * A step is released only when core would still honor its stamp: its latest
 * `step_started` carries an owner, it has no `step_retrying`, and it has no
 * terminal event. Queue-owned and finished steps are left alone.
 *
 * Every stamp is treated as dead, so this must run before this process
 * delivers any message for the run. Releasing a step this process is still
 * running would let the step run twice.
 */
export async function releaseOrphanedSteps(
  events: Storage['events'],
  runId: string
): Promise<void> {
  for (const [stepId, step] of await readStepOwnership(events, runId)) {
    if (step.owner === undefined || step.retried || step.finished) continue;
    try {
      await events.create(runId, {
        eventType: 'step_retrying',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: stepId,
        eventData: {
          ...(step.stepName !== undefined && { stepName: step.stepName }),
          error: orphanedStepError(),
        },
      });
    } catch (err) {
      // The step finished between the read and this write: nothing to release.
      if (!EntityConflictError.is(err)) throw err;
    }
  }
}

interface StepOwnership {
  /** `ownerMessageId` of the latest `step_started`. */
  owner?: string;
  stepName?: string;
  retried: boolean;
  finished: boolean;
}

async function readStepOwnership(
  events: Storage['events'],
  runId: string
): Promise<Map<string, StepOwnership>> {
  const steps = new Map<string, StepOwnership>();
  let cursor: string | undefined;
  do {
    const page = await events.list({
      runId,
      resolveData: 'none',
      pagination: { sortOrder: 'asc', cursor },
    });
    for (const event of page.data) {
      if (event.correlationId && isStepEventType(event.eventType)) {
        let step = steps.get(event.correlationId);
        if (!step) {
          step = { retried: false, finished: false };
          steps.set(event.correlationId, step);
        }
        applyStepEvent(step, event);
      }
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor);
  return steps;
}

function applyStepEvent(step: StepOwnership, event: Event): void {
  const data = ('eventData' in event ? event.eventData : undefined) as
    | { stepName?: unknown; ownerMessageId?: unknown }
    | undefined;
  if (typeof data?.stepName === 'string') step.stepName ??= data.stepName;
  switch (event.eventType) {
    case 'step_started':
      // The latest start wins: an unstamped one leaves the step queue-owned.
      step.owner =
        typeof data?.ownerMessageId === 'string'
          ? data.ownerMessageId
          : undefined;
      break;
    case 'step_retrying':
      step.retried = true;
      break;
    case 'step_completed':
    case 'step_failed':
      step.finished = true;
      break;
  }
}

/**
 * The error recorded on the released attempt, in the format core's
 * `dehydrateStepError` writes for an unencrypted, uncompressed thrown `Error`:
 * the `devl` prefix followed by devalue's encoding of the error's reduced
 * form. Local runs are never encrypted, so no key is involved.
 */
function orphanedStepError(): Uint8Array {
  const devalue = JSON.stringify([
    ['Error', 1],
    { name: 2, message: 3 },
    'Error',
    ORPHANED_STEP_ERROR_MESSAGE,
  ]);
  return new TextEncoder().encode(`devl${devalue}`);
}
