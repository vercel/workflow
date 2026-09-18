import { describe, expect, it, vi } from 'vitest';
import { importKey } from './encryption.js';
import { Sequence } from './sequence.js';
import { registerStepFunction } from './private.js';
import { executeStep } from './runtime/step-executor.js';
import { setWorld } from './runtime/world.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  hydrateStepReturnValue,
} from './serialization.js';

/** Queued-step regression: no workflow replay/cache prerequisite exists. */
describe('Sequence queued retry before workflow replay', () => {
  it('resolves encrypted authoritative ancestors before body and continues from exact prefix', async () => {
    const material = crypto.getRandomValues(new Uint8Array(32));
    const key = await importKey(material);
    const runId = 'wrun_output_retry';
    const outputs = new Map<string, Uint8Array>();
    const make = async (stepId: string, value: unknown) => {
      const bytes = (await dehydrateStepReturnValue(
        value,
        runId,
        key,
        [],
        globalThis,
        false,
        false,
        false,
        undefined,
        [],
        stepId
      )) as Uint8Array;
      outputs.set(stepId, bytes);
      return await hydrateStepReturnValue(bytes, runId, key);
    };
    const one = (await make('step_one', {
      history: Sequence.from([{ n: 0 }, { n: 1 }]),
    })) as { history: Sequence<{ n: number }> };
    const two = (await make('step_two', {
      history: one.history.take(1).append({ n: 2 }),
    })) as { history: Sequence<{ n: number }> };
    const get = vi.fn(async (_run: string, stepId: string) => ({
      status: 'completed',
      output: outputs.get(stepId),
    }));
    const events: unknown[] = [];
    const world = {
      specVersion: 6,
      steps: { get },
      runs: { get: async () => ({ runId }) },
      getEncryptionKeyForRun: async () => material,
      events: {
        create: vi.fn(async (_id: string, event: any) => {
          events.push(event);
          const step = {
            runId,
            stepId: event.correlationId,
            stepName,
            status:
              event.eventType === 'step_completed' ? 'completed' : 'running',
            attempt: 2,
            input,
            createdAt: new Date(),
            updatedAt: new Date(),
            startedAt: new Date(),
          };
          return {
            event: {
              ...event,
              runId,
              eventId: `evnt_${events.length}`,
              createdAt: new Date(),
            },
            step,
            ...(event.eventType === 'step_started'
              ? { stepCreated: true }
              : {}),
          };
        }),
      },
    } as never;
    setWorld(world);
    let bodyCalls = 0;
    const workflowCalls = 0;
    const stepName = 'step//queued-history';
    registerStepFunction(stepName, async (history: Sequence<{ n: number }>) => {
      bodyCalls++;
      const values = await history.toArray();
      expect(values).toEqual([{ n: 0 }, { n: 2 }]);
      return history.append({ n: 3 });
    });
    const input = await dehydrateStepArguments(
      { args: [two.history], closureVars: undefined, thisVal: undefined },
      runId,
      key
    );
    const result = await executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId: 'step_retry',
      stepName,
      encryptionKey: key,
      lazyStepInput: input as Uint8Array,
      authoritativeAttempt: 2,
    });
    expect(result.type).toBe('completed');
    expect(workflowCalls).toBe(0);
    expect(bodyCalls).toBe(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.map((call) => call[1])).toEqual([
      'step_two',
      'step_one',
    ]);
    expect(
      events.some((event: any) => event.eventType === 'step_completed')
    ).toBe(true);
  });
});
