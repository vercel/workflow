import { describe, expect, it } from 'vitest';
import { resumeHookOrStart } from 'workflow/api';
import { HookConflictError } from 'workflow/errors';
import { collectMessages } from '../workflows/resume-hook-or-start.js';

const freshToken = (name: string) =>
  `${name}:${Math.random().toString(36).slice(2)}`;

describe('resumeHookOrStart', () => {
  it('starts one run for concurrent callers and delivers every payload to it', async () => {
    const token = freshToken('chat');
    const messages = ['a', 'b', 'c', 'd', 'e'];

    const results = await Promise.all(
      messages.map((message) =>
        resumeHookOrStart(token, message, collectMessages, [
          token,
          message,
          messages.length,
        ])
      )
    );

    expect(results.filter((r) => r.action === 'started')).toHaveLength(1);
    const runIds = new Set(results.map((r) => r.run.runId));
    expect(runIds.size).toBe(1);

    const run = results[0].run;
    const received = await run.returnValue;
    expect([...received].sort()).toEqual(messages);
  }, 60_000);

  it('starts a new run once the previous owner has finished', async () => {
    const token = freshToken('session');

    const first = await resumeHookOrStart(token, 'one', collectMessages, [
      token,
      'one',
      1,
    ]);
    expect(first.action).toBe('started');
    await expect(first.run.returnValue).resolves.toEqual(['one']);

    const second = await resumeHookOrStart(token, 'two', collectMessages, [
      token,
      'two',
      1,
    ]);
    expect(second.action).toBe('started');
    expect(second.run.runId).not.toBe(first.run.runId);
    await expect(second.run.returnValue).resolves.toEqual(['two']);
  }, 60_000);

  it('throws the conflict while a finished owner retains the token', async () => {
    const token = freshToken('retained');

    const first = await resumeHookOrStart(
      token,
      'one',
      collectMessages,
      [token, 'one', 1],
      { experimental_minRetention: '1h' }
    );
    await expect(first.run.returnValue).resolves.toEqual(['one']);

    const error = await resumeHookOrStart(token, 'two', collectMessages, [
      token,
      'two',
      1,
    ]).catch((e: unknown) => e);
    expect(HookConflictError.is(error)).toBe(true);
    expect((error as HookConflictError).conflictingRunId).toBe(first.run.runId);
  }, 60_000);
});
