import type { CreateEventRequest, Event, WorkflowRun } from '@workflow/world';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from './serialization.js';
import { replayWorkflow } from './workflow.js';

afterEach(() => vi.unstubAllEnvs());

const workflowCode = `
  const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
  const setAttributes = globalThis[Symbol.for('WORKFLOW_SET_ATTRIBUTES')];
  const step = globalThis[Symbol.for('WORKFLOW_USE_STEP')];
  const record = step('record');
  const afterRestart = step('afterRestart');
  globalThis.__private_workflows = new Map([['workflow', async () => {
    const cancel = createHook({ token: 'cancel' });
    const winner = await Promise.race([
      setAttributes([{ key: 'phase', value: 'preparing' }]).then(() => 'prepared'),
      (async () => { await cancel; return 'cancelled'; })(),
    ]);
    const recorded = await record(winner);
    const signal = await createHook({ token: 'finish' });
    return afterRestart(winner, recorded, signal);
  }]]);
`;

describe.each([
  '0',
  '1',
])('attribute upgrade recovery (WORKFLOW_LOG_ORDER_DRAWS=%s)', (draws) => {
  it.each([
    { runId: 'wrun_legacy_attribute', recorded: 'prepared' },
    { runId: 'wrun_post_fix_attribute', recorded: 'cancelled' },
  ])('preserves the recorded decision for $runId', async ({
    runId,
    recorded,
  }) => {
    vi.stubEnv('WORKFLOW_LOG_ORDER_DRAWS', draws);
    vi.stubEnv(
      'WORKFLOW_LEGACY_ATTRIBUTE_RUN_IDS',
      ' wrun_legacy_attribute , wrun_unrelated '
    );
    const createdAt = new Date('2025-01-01T00:00:00Z');
    const run: WorkflowRun = {
      runId,
      workflowName: 'workflow',
      status: 'running',
      attributes: {},
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      deploymentId: 'postgres',
      // Both source revisions around #4861 declared 5.2.1. Version-based
      // detection cannot distinguish their attribute delivery algorithms.
      executionContext: { workflowCoreVersion: '5.2.1' },
      input: await dehydrateWorkflowArguments([], runId, undefined),
    };
    const events: Event[] = [];
    const append = (request: CreateEventRequest) => {
      events.push({
        ...request,
        runId,
        eventId: `evnt_${String(events.length + 1).padStart(26, '0')}`,
        createdAt: new Date(+createdAt + events.length + 1),
        specVersion: 3,
      } as Event);
    };
    const replay = () =>
      replayWorkflow({
        workflowCode,
        workflowRun: run,
        events: [...events],
        encryptionKey: undefined,
        replayPayloadCache: new ReplayPayloadCache(undefined),
      });
    const initial = await replay();
    assert(initial.type === 'suspended');
    const cancel = initial.suspension.items.find(
      (item) => item.type === 'hook'
    );
    const attribute = initial.suspension.items.find(
      (item) => item.type === 'attribute'
    );
    assert(cancel?.type === 'hook' && attribute?.type === 'attribute');
    append({
      eventType: 'hook_created',
      correlationId: cancel.correlationId,
      eventData: { token: 'cancel' },
    });
    append({
      eventType: 'hook_received',
      correlationId: cancel.correlationId,
      eventData: {
        payload: await dehydrateStepReturnValue('cancel', runId, undefined),
      },
    });
    append({
      eventType: 'attr_set',
      correlationId: attribute.correlationId,
      eventData: {
        changes: attribute.changes,
        writer: { type: 'workflow' },
      },
    });
    const decided = await replay();
    assert(decided.type === 'suspended');
    const record = decided.suspension.items.find(
      (item) => item.type === 'step'
    );
    assert(record?.type === 'step');
    // The historical decision is fixed, independent of what today's
    // runtime computed. Otherwise a broken replay would make its own oracle.
    append({
      eventType: 'step_created',
      correlationId: record.correlationId,
      eventData: {
        stepName: record.stepName,
        input: await dehydrateStepArguments([recorded], runId, undefined),
      },
    });
    append({
      eventType: 'step_started',
      correlationId: record.correlationId,
      eventData: { stepName: record.stepName },
    });
    append({
      eventType: 'step_completed',
      correlationId: record.correlationId,
      eventData: {
        result: await dehydrateStepReturnValue(recorded, runId, undefined),
      },
    });
    const paused = await replay();
    assert(paused.type === 'suspended');
    const finish = paused.suspension.items.find(
      (item) => item.type === 'hook' && item.token === 'finish'
    );
    assert(finish?.type === 'hook');
    append({
      eventType: 'hook_created',
      correlationId: finish.correlationId,
      eventData: { token: 'finish' },
    });
    append({
      eventType: 'hook_received',
      correlationId: finish.correlationId,
      eventData: {
        payload: await dehydrateStepReturnValue('continue', runId, undefined),
      },
    });
    const resumed = await replay();
    assert(resumed.type === 'suspended');
    const nextStep = resumed.suspension.items.find(
      (item) => item.type === 'step'
    );
    assert(nextStep?.type === 'step');
    expect(nextStep.stepName).toBe('afterRestart');
    expect(nextStep.args).toEqual([recorded, recorded, 'continue']);
  });
});
