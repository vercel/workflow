import { channel } from 'node:diagnostics_channel';
import { expect, it } from 'vitest';
import { observeWorkflowPass } from './execution-observation.js';

it('records actual replay fallback and excludes results and error contents', async () => {
  const events: unknown[] = [];
  const receiver = (event: unknown) => {
    events.push(event);
  };
  const observations = channel('workflow.execution');
  observations.subscribe(receiver);
  try {
    const context = {
      runId: 'run-test',
      loopIteration: 2,
      mode: 'retained' as const,
    };
    await expect(
      observeWorkflowPass(context, async (setMode) => {
        setMode('replay');
        return 'private-result';
      })
    ).resolves.toBe('private-result');
    expect(events[0]).toMatchObject({ event: 'begin', mode: 'retained' });
    expect(events[1]).toMatchObject({
      event: 'end',
      mode: 'replay',
      status: 'completed',
    });
    await expect(
      observeWorkflowPass(context, async () => {
        throw new Error('private-error');
      })
    ).rejects.toThrow('private-error');
    expect(events[3]).toMatchObject({
      event: 'end',
      mode: 'retained',
      status: 'error',
    });
    expect(JSON.stringify(events)).not.toContain('private-');
  } finally {
    observations.unsubscribe(receiver);
  }
});
