import { describe, expect, it } from 'vitest';
import { InlineStepsInFlight } from './inline-steps-in-flight.js';

type Result = { type: 'completed' | 'retry' };

const isClean = (outcome: PromiseSettledResult<Result>) =>
  outcome.status === 'fulfilled' && outcome.value.type === 'completed';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function trackStep(
  steps: InlineStepsInFlight<{ correlationId: string }, Result>,
  id: string
) {
  const execution = deferred<Result>();
  const start = deferred<void>();
  steps.track({ correlationId: id }, execution.promise, start.promise);
  return { execution, start };
}

describe('InlineStepsInFlight', () => {
  it('returns early with the clean settlement and keeps the running step', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    b.start.resolve();
    a.execution.resolve({ type: 'completed' });

    const round = await steps.settle(true, isClean);
    expect(round.early).toBe(true);
    expect(round.settled.map((s) => s.step.correlationId)).toEqual(['a']);
    expect([...steps.ids]).toEqual(['b']);

    b.execution.resolve({ type: 'completed' });
    const last = await steps.settle(true, isClean);
    expect(last.early).toBe(false);
    expect(last.settled.map((s) => s.step.correlationId)).toEqual(['b']);
    expect(steps.size).toBe(0);
  });

  it('waits for a running step whose claim has not settled', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    a.execution.resolve({ type: 'completed' });

    let returned = false;
    const round = steps.settle(true, isClean).then((r) => {
      returned = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(returned).toBe(false);

    b.start.resolve();
    expect((await round).early).toBe(true);
  });

  it('waits for the whole batch after an outcome that needs batch handling', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    b.start.resolve();
    a.execution.resolve({ type: 'retry' });
    setTimeout(() => b.execution.resolve({ type: 'completed' }), 5);

    const round = await steps.settle(true, isClean);
    expect(round.early).toBe(false);
    expect(round.settled.map((s) => s.step.correlationId)).toEqual(['a', 'b']);
  });

  it('treats a rejection as needing batch handling', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    b.start.resolve();
    a.execution.reject(new Error('boom'));
    setTimeout(() => b.execution.resolve({ type: 'completed' }), 5);

    const round = await steps.settle(true, isClean);
    expect(round.early).toBe(false);
    expect(round.settled[0].outcome.status).toBe('rejected');
  });

  it('never returns early when disabled', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    b.start.resolve();
    a.execution.resolve({ type: 'completed' });
    setTimeout(() => b.execution.resolve({ type: 'completed' }), 5);

    const round = await steps.settle(false, isClean);
    expect(round.early).toBe(false);
    expect(round.settled).toHaveLength(2);
  });

  it('takes settled clean steps without waiting, and nothing while one runs', async () => {
    const steps = new InlineStepsInFlight<{ correlationId: string }, Result>();
    const a = trackStep(steps, 'a');
    const b = trackStep(steps, 'b');
    a.execution.resolve({ type: 'completed' });
    await a.execution.promise;
    expect(steps.takeIfAllSettled(isClean)).toBe(false);
    expect(steps.size).toBe(2);

    b.execution.resolve({ type: 'retry' });
    await steps.settle(false, isClean).then(() => {});
    expect(steps.size).toBe(0);

    const c = trackStep(steps, 'c');
    c.execution.resolve({ type: 'completed' });
    await c.execution.promise;
    await Promise.resolve();
    expect(steps.takeIfAllSettled(isClean)).toBe(true);
    expect(steps.ids.size).toBe(0);
  });
});
