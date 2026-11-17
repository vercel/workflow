import type { World } from '@workflow/world';
import { produce } from 'immer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import {
  bindStateContext,
  StateContext,
} from '../../serialization/state-refs.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
} from '../../serialization.js';
import { setWorld } from '../world.js';
import { executeStep } from './step-executor.js';

// The World recovery reads the run's log through: its reads fail.
vi.mock('../get-world-lazy.js', () => ({
  getWorldLazy: async () => ({
    runs: { get: async () => ({ input: undefined }) },
    events: {
      list: async () => {
        throw new Error('socket hang up');
      },
    },
  }),
}));

const stepName = 'step//./state-recovery-test//noop';
registerStepFunction(stepName, async () => 'ok');

const RUN = 'wrun_state_recovery';

describe('executeStep (spec 9): rebuilding a step input from the log fails', () => {
  afterEach(() => setWorld(undefined));

  it('rethrows for redelivery instead of failing or retrying the step', async () => {
    const vm = Object.create(globalThis);
    const replay = new StateContext();
    bindStateContext(vm, replay);
    const state = produce({ log: [] as string[] }, (d) => {
      d.log.push('a');
    });
    await dehydrateStepReturnValue(
      state,
      RUN,
      undefined,
      [],
      globalThis,
      false,
      false,
      false,
      undefined,
      [],
      false,
      replay
    );
    const input = (await dehydrateStepArguments(
      { args: [state], closureVars: undefined, thisVal: undefined },
      RUN,
      undefined,
      vm
    )) as Uint8Array;
    // A copy, as a queued step reads it from storage: not the bytes the
    // replay wrote, which carry its context along.
    const stored = new Uint8Array(input);
    const written: string[] = [];
    const execution = executeStep({
      world: {
        getEncryptionKeyForRun: async () => undefined,
      } as unknown as World,
      workflowRunId: RUN,
      workflowName: 'workflow',
      workflowStartedAt: Date.now(),
      stepId: 'step_a',
      stepName,
      attempt: 1,
      input: stored,
      createEvent: async (data) => {
        written.push(data.eventType);
        return {
          event: {
            ...data,
            runId: RUN,
            eventId: `evnt_${written.length}`,
            createdAt: new Date(),
          },
        } as never;
      },
    });
    await expect(execution).rejects.toMatchObject({
      name: 'WorkflowStateRecoveryError',
    });
    expect(written).not.toContain('step_retrying');
    expect(written).not.toContain('step_failed');
    expect(written).not.toContain('step_completed');
  });
});
