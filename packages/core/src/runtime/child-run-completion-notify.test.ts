import { HookNotFoundError, WorkflowWorldError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import {
  CHILD_RUN_COMPLETION_CONTEXT_KEY,
  childRunCompletionToken,
} from './child-run-completion.js';
import {
  isChildRunCompletionHookEnabled,
  notifyParentOfRunCompletion,
} from './child-run-completion-notify.js';
import { resumeHookOnWorld } from './resume-hook.js';

vi.mock('./resume-hook.js', () => ({ resumeHookOnWorld: vi.fn() }));

const resume = vi.mocked(resumeHookOnWorld);

describe('notifyParentOfRunCompletion', () => {
  const stamped = {
    runId: 'wrun_child',
    executionContext: { [CHILD_RUN_COMPLETION_CONTEXT_KEY]: 'wrun_parent' },
  };
  let runsGet: ReturnType<typeof vi.fn>;
  let world: any;

  beforeEach(() => {
    vi.useFakeTimers();
    runsGet = vi.fn();
    world = { runs: { get: runsGet } };
    resume.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resumes the completion hook of a stamped run', async () => {
    resume.mockResolvedValue({} as any);
    await notifyParentOfRunCompletion(world, stamped, 'completed');

    // The parent's one hook, told which of its children finished.
    expect(resume).toHaveBeenCalledWith(
      world,
      childRunCompletionToken('wrun_parent'),
      { runId: 'wrun_child', status: 'completed' }
    );
    expect(runsGet).not.toHaveBeenCalled();
  });

  it('does nothing for a run that was not started from a workflow', async () => {
    await notifyParentOfRunCompletion(
      world,
      { runId: 'wrun_top', executionContext: {} },
      'completed'
    );
    expect(resume).not.toHaveBeenCalled();
  });

  it('reads the run (metadata only) when given just its id', async () => {
    runsGet.mockResolvedValue(stamped);
    resume.mockResolvedValue({} as any);
    await notifyParentOfRunCompletion(world, 'wrun_child', 'failed');

    expect(runsGet).toHaveBeenCalledWith('wrun_child', { resolveData: 'none' });
    expect(resume).toHaveBeenCalledWith(
      world,
      childRunCompletionToken('wrun_parent'),
      { runId: 'wrun_child', status: 'failed' }
    );
  });

  it('treats a missing hook as "no parent waiting"', async () => {
    const error = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    resume.mockRejectedValue(new HookNotFoundError('t'));
    await notifyParentOfRunCompletion(world, stamped, 'completed');

    expect(resume).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('retries transient failures', async () => {
    resume
      .mockRejectedValueOnce(new WorkflowWorldError('boom', { status: 503 }))
      .mockResolvedValueOnce({} as any);
    const done = notifyParentOfRunCompletion(world, stamped, 'cancelled');
    await vi.runAllTimersAsync();
    await done;

    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('logs instead of throwing once retries are exhausted', async () => {
    const error = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    resume.mockRejectedValue(new WorkflowWorldError('down', { status: 503 }));
    const done = notifyParentOfRunCompletion(world, stamped, 'completed');
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();

    expect(resume).toHaveBeenCalledTimes(5);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('does not retry a definitive failure', async () => {
    const error = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
    resume.mockRejectedValue(new WorkflowWorldError('bad', { status: 400 }));
    await notifyParentOfRunCompletion(world, stamped, 'completed');

    expect(resume).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('isChildRunCompletionHookEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [undefined, true],
    ['', true],
    ['1', true],
    ['0', false],
    ['false', false],
    ['FALSE', false],
  ])('WORKFLOW_CHILD_RUN_COMPLETION_HOOK=%s -> %s', (value, expected) => {
    if (value === undefined) {
      vi.stubEnv('WORKFLOW_CHILD_RUN_COMPLETION_HOOK', undefined as any);
      delete process.env.WORKFLOW_CHILD_RUN_COMPLETION_HOOK;
    } else {
      vi.stubEnv('WORKFLOW_CHILD_RUN_COMPLETION_HOOK', value);
    }
    expect(isChildRunCompletionHookEnabled()).toBe(expected);
  });
});
