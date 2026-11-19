import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
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
import { SPEC8_EVENT_SPEC_VERSION } from './constants.js';
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

describe('executeStep (spec 8): rebuilding a step input from the log fails', () => {
  afterEach(() => setWorld(undefined));

  it('rethrows for redelivery instead of failing or retrying the step', async () => {
    const world: World = createWorld({
      dataDir: mkdtempSync(join(tmpdir(), 'wf-state-recovery-')),
    });
    const created = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'wf',
        input: await dehydrateStepArguments([], 'run', undefined),
      },
    });
    const runId = created.run!.runId;
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      eventData: {},
    } as never);

    // A workflow that knows a version (an earlier output) passes it on: the
    // step input is a reference only the run's log can resolve.
    const vm = Object.create(globalThis);
    const replay = new StateContext();
    bindStateContext(vm, replay);
    const state = produce({ log: [] as string[] }, (d) => {
      d.log.push('a');
    });
    await dehydrateStepReturnValue(
      state,
      runId,
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
    const stepInput = await dehydrateStepArguments(
      { args: [state], closureVars: undefined, thisVal: undefined },
      runId,
      undefined,
      vm
    );
    const stepId = 'step_recovery_1';
    await world.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      correlationId: stepId,
      eventData: { stepName, input: stepInput },
    });

    const execution = executeStep({
      world,
      workflowRunId: runId,
      workflowName: 'wf',
      workflowStartedAt: Date.now(),
      stepId,
      stepName,
      authoritativeAttempt: 1,
    });
    await expect(execution).rejects.toMatchObject({
      name: 'WorkflowStateRecoveryError',
    });
    const { data } = await world.events.list({ runId });
    const outcomes = data
      .filter((e) => e.correlationId === stepId)
      .map((e) => e.eventType);
    expect(outcomes).not.toContain('step_retrying');
    expect(outcomes).not.toContain('step_failed');
    expect(outcomes).not.toContain('step_completed');
  });
});
