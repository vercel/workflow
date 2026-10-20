import { createHook } from 'workflow';
import { start } from 'workflow/api';
import { WorkflowRunAlreadyStartedError } from 'workflow/internal/errors';

async function echo(value: string): Promise<string> {
  'use step';
  return value;
}

/** Completes with its argument. */
export async function keyedEcho(value: string) {
  'use workflow';
  return await echo(value);
}

/** Stays running until its hook is resumed, so it holds its key. */
export async function keyedHold(token: string) {
  'use workflow';
  const hook = createHook<{ done: boolean }>({ token });
  await hook;
  return 'released';
}

/**
 * Starts `keyedHold` from workflow code with the FAIL conflict policy and
 * reports the refusal it caught, which crossed the step boundary.
 */
export async function keyedFailFromWorkflow(key: string) {
  'use workflow';
  try {
    const run = await start(keyedHold, [`${key}-unreachable`], {
      experimental_idempotencyKey: key,
      experimental_idempotencyKeyConflictPolicy: 'FAIL',
    });
    return { refused: false, runId: run.runId };
  } catch (error) {
    if (WorkflowRunAlreadyStartedError.is(error)) {
      return { refused: true, runId: error.runId };
    }
    throw error;
  }
}
