/**
 * Fixtures for `start({ experimental_idempotencyKey })` e2e coverage.
 *
 * Keys are scoped by workflow, so every case that expects a refusal or a
 * returned holder starts the same workflow function with the same key.
 */
import { createHook } from 'workflow';
import { start } from 'workflow/api';
import { WorkflowRunAlreadyStartedError } from 'workflow/internal/errors';

async function echo(value: string): Promise<string> {
  'use step';
  return value;
}

/** Completes with its argument. */
export async function idempotentEchoWorkflow(value: string) {
  'use workflow';
  return await echo(value);
}

/** Stays running until its hook is resumed, so it holds its key. */
export async function idempotentHoldWorkflow(token: string) {
  'use workflow';
  const hook = createHook<{ done: boolean }>({ token });
  await hook;
  return 'released';
}

/**
 * Starts `idempotentHoldWorkflow` from workflow code with the `FAIL` conflict
 * policy and reports what it caught. With the key already held, the refusal
 * crosses the step boundary, so this checks that workflow code receives a
 * `WorkflowRunAlreadyStartedError` it can recognize and read the holder from.
 */
export async function idempotentFailFromWorkflow(key: string) {
  'use workflow';
  try {
    const run = await start(idempotentHoldWorkflow, [`${key}-unreachable`], {
      experimental_idempotencyKey: key,
      experimental_idempotencyKeyConflictPolicy: 'FAIL',
    });
    return { refused: false, runId: run.runId };
  } catch (error) {
    if (WorkflowRunAlreadyStartedError.is(error)) {
      return {
        refused: true,
        runId: error.runId,
        runStatus: error.runStatus ?? null,
        idempotencyKey: error.idempotencyKey ?? null,
      };
    }
    throw error;
  }
}
