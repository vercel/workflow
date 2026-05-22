import { waitForHook } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { resumeHook, start } from 'workflow/api';
import { serializableStepsWorkflow } from '../workflows/cookbook/serializable-steps.js';
import { durableCounter } from '../workflows/cookbook/durable-objects.js';

describe('serializable steps', () => {
  it('step-as-factory: provider is constructed inside step context', async () => {
    const run = await start(serializableStepsWorkflow, ['test-model', 'hello']);

    const result = await run.returnValue;

    expect(result).toEqual({
      modelName: 'test-model',
      result: 'test-model:hello',
    });
  });
});

describe('durable objects', () => {
  it('hook-based method dispatch accumulates state', async () => {
    const run = await start(durableCounter, [3]);

    // Op 0: increment by 5
    await waitForHook(run, { token: 'counter:op-0' });
    await resumeHook('counter:op-0', { type: 'increment', amount: 5 });

    // Op 1: increment by 3
    await waitForHook(run, { token: 'counter:op-1' });
    await resumeHook('counter:op-1', { type: 'increment', amount: 3 });

    // Op 2: decrement by 2
    await waitForHook(run, { token: 'counter:op-2' });
    await resumeHook('counter:op-2', { type: 'decrement', amount: 2 });

    const result = await run.returnValue;

    expect(result).toEqual({
      finalCount: 6, // 0 + 5 + 3 - 2
      totalOps: 3,
    });
  });

  it('get operation does not change state', async () => {
    const run = await start(durableCounter, [2]);

    // Op 0: increment by 10
    await waitForHook(run, { token: 'counter:op-0' });
    await resumeHook('counter:op-0', { type: 'increment', amount: 10 });

    // Op 1: get (should not change count)
    await waitForHook(run, { token: 'counter:op-1' });
    await resumeHook('counter:op-1', { type: 'get' });

    const result = await run.returnValue;

    expect(result).toEqual({
      finalCount: 10,
      totalOps: 2,
    });
  });
});
