import {
  HookConflictError,
  HookNotFoundError,
  WorkflowRuntimeError,
  WorkflowStartError,
  WorkflowWorldError,
} from '@workflow/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resumeHook = vi.fn();
const resumeHookOnWorld = vi.fn();
const start = vi.fn();

vi.mock('./resume-hook.js', () => ({
  resumeHook: (...a: unknown[]) => resumeHook(...a),
  resumeHookOnWorld: (...a: unknown[]) => resumeHookOnWorld(...a),
}));
vi.mock('./start.js', () => ({
  start: (...a: unknown[]) => start(...a),
}));
vi.mock('./run.js', () => ({
  getRun: (runId: string) => ({ runId }),
}));

const { resumeHookOrStart } = await import('./resume-hook-or-start.js');

const TOKEN = 'chat:thread-1';
const workflow = { workflowId: 'workflow//./chat//chatSession' };
const notFound = () => new HookNotFoundError(TOKEN);
const conflict = (runId: string) => new HookConflictError(TOKEN, runId);
const resumed = (runId: string) => ({ runId, hookId: 'hook_1', token: TOKEN });

/** The sequence of calls the helper made, e.g. ['resume', 'start']. */
const calls = () =>
  [
    ...resumeHook.mock.invocationCallOrder.map((n) => [n, 'resume'] as const),
    ...start.mock.invocationCallOrder.map((n) => [n, 'start'] as const),
  ]
    .sort((a, b) => a[0] - b[0])
    .map(([, name]) => name);

beforeEach(() => {
  resumeHook.mockReset();
  resumeHookOnWorld.mockReset();
  start.mockReset();
});

describe('resumeHookOrStart', () => {
  it('delivers the payload to a run that owns the token, without starting one', async () => {
    resumeHook.mockResolvedValueOnce(resumed('wrun_owner'));

    const result = await resumeHookOrStart(TOKEN, { text: 'hi' }, workflow, [
      'thread-1',
    ]);

    expect(result).toMatchObject({
      action: 'resumed',
      run: { runId: 'wrun_owner' },
      hook: { runId: 'wrun_owner' },
    });
    expect(resumeHook).toHaveBeenCalledWith(TOKEN, { text: 'hi' });
    expect(start).not.toHaveBeenCalled();
  });

  it('starts the workflow holding the token when no Hook answers', async () => {
    resumeHook.mockRejectedValueOnce(notFound());
    start.mockResolvedValueOnce({ runId: 'wrun_new' });

    const result = await resumeHookOrStart(
      TOKEN,
      { text: 'hi' },
      workflow,
      ['thread-1', { text: 'hi' }],
      {
        experimental_minRetention: '1h',
        metadata: { threadId: 'thread-1' },
        deploymentId: 'latest',
        region: 'iad1',
      }
    );

    expect(result).toEqual({ action: 'started', run: { runId: 'wrun_new' } });
    expect(start).toHaveBeenCalledWith(workflow, ['thread-1', { text: 'hi' }], {
      deploymentId: 'latest',
      region: 'iad1',
      experimental_hook: {
        token: TOKEN,
        experimental_minRetention: '1h',
        metadata: { threadId: 'thread-1' },
      },
    });
  });

  it('passes only the token when no retention or metadata is set', async () => {
    resumeHook.mockRejectedValueOnce(notFound());
    start.mockResolvedValueOnce({ runId: 'wrun_new' });

    await resumeHookOrStart(TOKEN, 1, workflow, []);

    expect(start.mock.calls[0][2]).toEqual({
      experimental_hook: { token: TOKEN },
    });
  });

  it('resumes the run a racing caller started first', async () => {
    resumeHook
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(resumed('wrun_racer'));
    start.mockRejectedValueOnce(conflict('wrun_racer'));

    const result = await resumeHookOrStart(TOKEN, 'payload', workflow, []);

    expect(result).toMatchObject({
      action: 'resumed',
      run: { runId: 'wrun_racer' },
    });
    expect(calls()).toEqual(['resume', 'start', 'resume']);
  });

  it('starts a new run when the owner ended between the refused start and the resume', async () => {
    resumeHook
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(notFound());
    start
      .mockRejectedValueOnce(conflict('wrun_ending'))
      .mockResolvedValueOnce({ runId: 'wrun_next' });

    const result = await resumeHookOrStart(TOKEN, 'payload', workflow, []);

    expect(result).toEqual({ action: 'started', run: { runId: 'wrun_next' } });
    expect(calls()).toEqual(['resume', 'start', 'resume', 'start']);
  });

  it('throws the conflict when a finished owner keeps the token for its retention', async () => {
    resumeHook.mockRejectedValue(notFound());
    start.mockRejectedValue(conflict('wrun_finished'));

    const error = await resumeHookOrStart(TOKEN, 'payload', workflow, []).catch(
      (e: unknown) => e
    );

    expect(HookConflictError.is(error)).toBe(true);
    expect((error as HookConflictError).conflictingRunId).toBe('wrun_finished');
    // resume (gone) → start (refused by X) → resume (X gone) → start (X again)
    expect(calls()).toEqual(['resume', 'start', 'resume', 'start']);
  });

  it('keeps going while the token changes hands between racing callers', async () => {
    resumeHook
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(resumed('wrun_b'));
    start
      .mockRejectedValueOnce(conflict('wrun_a'))
      .mockRejectedValueOnce(conflict('wrun_b'));

    const result = await resumeHookOrStart(TOKEN, 'payload', workflow, []);

    expect(result).toMatchObject({
      action: 'resumed',
      run: { runId: 'wrun_b' },
    });
  });

  it('retries a start whose outcome is unknown with the same token', async () => {
    resumeHook.mockRejectedValueOnce(notFound());
    start
      .mockRejectedValueOnce(new WorkflowStartError('wrun_cand', 'admission'))
      .mockResolvedValueOnce({ runId: 'wrun_cand' });

    const result = await resumeHookOrStart(TOKEN, 'payload', workflow, []);

    expect(result).toEqual({ action: 'started', run: { runId: 'wrun_cand' } });
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1][2]).toEqual(start.mock.calls[0][2]);
  });

  it('waits out a retryAfter before resuming again', async () => {
    resumeHook
      .mockRejectedValueOnce(
        new WorkflowWorldError('run pending', {
          status: 503,
          code: 'start-hook-run-pending',
          retryAfter: 0.01,
        })
      )
      .mockResolvedValueOnce(resumed('wrun_pending'));

    const result = await resumeHookOrStart(TOKEN, 'payload', workflow, []);

    expect(result).toMatchObject({ action: 'resumed' });
    expect(resumeHook).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  it('throws any other error at once', async () => {
    resumeHook.mockRejectedValueOnce(new WorkflowRuntimeError('broken'));

    await expect(
      resumeHookOrStart(TOKEN, 'payload', workflow, [])
    ).rejects.toThrow('broken');
    expect(start).not.toHaveBeenCalled();
  });

  it('stops after maxAttempts and throws the last error', async () => {
    let n = 0;
    resumeHook.mockRejectedValue(notFound());
    start.mockImplementation(async () => {
      throw conflict(`wrun_${n++}`);
    });

    const error = await resumeHookOrStart(TOKEN, 'p', workflow, [], {
      maxAttempts: 4,
    }).catch((e: unknown) => e);

    expect(HookConflictError.is(error)).toBe(true);
    expect(resumeHook.mock.calls.length + start.mock.calls.length).toBe(4);
  });

  it('resumes through the World it was given', async () => {
    const world = { name: 'custom' } as never;
    resumeHookOnWorld.mockResolvedValueOnce(resumed('wrun_owner'));

    await resumeHookOrStart(TOKEN, 'payload', workflow, [], { world });

    expect(resumeHookOnWorld).toHaveBeenCalledWith(world, TOKEN, 'payload');
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it('rejects an empty token and a bad maxAttempts before any call', async () => {
    await expect(resumeHookOrStart('', 1, workflow, [])).rejects.toThrow(
      'non-empty token'
    );
    await expect(
      resumeHookOrStart(TOKEN, 1, workflow, [], { maxAttempts: 0 })
    ).rejects.toThrow('maxAttempts');
    expect(resumeHook).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
