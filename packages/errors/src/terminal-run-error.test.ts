import { describe, expect, it } from 'vitest';
import {
  FatalError,
  WorkflowRunCancelledError,
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
  WorkflowRunNotFoundError,
} from './index.js';

/**
 * `failed` and `cancelled` are terminal, and a run's terminal state is
 * immutable. The errors that report them are only ever thrown after a run has
 * been read successfully, so the read that produced them cannot come back
 * different. `FatalError.is()` is the step executor's non-retry gate, and it
 * has to say so — otherwise a parent awaiting a child's `returnValue` spends
 * its whole retry budget re-reading the same record, and the error it finally
 * surfaces is the executor's retry-exhaustion wrapper rather than the one
 * callers are documented to catch. See vercel/workflow#4288.
 */
describe('terminal run errors are non-retryable', () => {
  it('marks WorkflowRunFailedError fatal', () => {
    const error = new WorkflowRunFailedError('wrun_1', {
      message: 'boom',
      code: 'USER_ERROR',
    });
    expect(FatalError.is(error)).toBe(true);
    // The marker is additive: identity and payload are unchanged.
    expect(WorkflowRunFailedError.is(error)).toBe(true);
    expect(error.runId).toBe('wrun_1');
    expect(error.cause.code).toBe('USER_ERROR');
    expect(error.cause.message).toBe('boom');
  });

  it('marks WorkflowRunCancelledError fatal', () => {
    const error = new WorkflowRunCancelledError('wrun_1');
    expect(FatalError.is(error)).toBe(true);
    expect(WorkflowRunCancelledError.is(error)).toBe(true);
    expect(error.runId).toBe('wrun_1');
  });

  it('leaves the non-terminal run errors retryable', () => {
    // Neither describes a settled run: `running` can still finish, and a run
    // that is missing now can exist a moment later (a resilient start races
    // its own `run_created`). Retrying either can produce a different answer.
    expect(
      FatalError.is(new WorkflowRunNotCompletedError('wrun_1', 'running'))
    ).toBe(false);
    expect(FatalError.is(new WorkflowRunNotFoundError('wrun_1'))).toBe(false);
  });
});
