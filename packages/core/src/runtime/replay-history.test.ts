import { CorruptedEventLogError } from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../serialization.js';
import { replayWorkflowHistory } from './replay-history.js';

const noEncryptionKey = undefined;

function getWorkflowTransformCode(workflowName: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, ${workflowName}]]);`;
}

async function createWorkflowRun(runId = 'wrun_replay_test') {
  return {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: await dehydrateWorkflowArguments([], runId, noEncryptionKey),
    createdAt: new Date('2026-05-21T00:00:00.000Z'),
    updatedAt: new Date('2026-05-21T00:00:00.000Z'),
    startedAt: new Date('2026-05-21T00:00:00.000Z'),
    deploymentId: 'test-deployment',
    specVersion: SPEC_VERSION_CURRENT,
  } satisfies WorkflowRun;
}

function createWorkflowCode() {
  return `
    const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
    async function workflow() {
      return await add(1, 2);
    }
    ${getWorkflowTransformCode('workflow')}
  `;
}

function createEvent(
  workflowRun: WorkflowRun,
  index: number,
  event: Omit<Event, 'eventId' | 'runId' | 'createdAt'>
): Event {
  return {
    eventId: `evnt_${index}`,
    runId: workflowRun.runId,
    createdAt: new Date(`2026-05-21T00:00:0${index}.000Z`),
    ...event,
  } as Event;
}

async function discoverStepCorrelationId(
  workflowRun: WorkflowRun,
  workflowCode: string
) {
  const result = await replayWorkflowHistory({
    workflowCode,
    workflowRun,
    events: [],
    encryptionKey: noEncryptionKey,
  });

  expect(result.status).toBe('suspended');
  if (result.status !== 'suspended') {
    throw new Error('expected suspended replay');
  }

  expect(result.counts).toMatchObject({
    steps: 1,
    hooks: 0,
    waits: 0,
  });
  expect(result.pendingOperations).toHaveLength(1);
  expect(result.pendingOperations[0]).toMatchObject({
    type: 'step',
    stepName: 'add',
  });

  return result.pendingOperations[0].correlationId;
}

describe('replayWorkflowHistory', () => {
  it('returns pending operations for an incomplete history', async () => {
    const workflowRun = await createWorkflowRun();
    const result = await replayWorkflowHistory({
      workflowCode: createWorkflowCode(),
      workflowRun,
      events: [],
      encryptionKey: noEncryptionKey,
    });

    expect(result).toMatchObject({
      status: 'suspended',
      counts: {
        steps: 1,
        hooks: 0,
        waits: 0,
        hookDisposals: 0,
        aborts: 0,
      },
    });
    expect(result.status).toBe('suspended');
    if (result.status === 'suspended') {
      expect(result.pendingOperations[0]).toMatchObject({
        type: 'step',
        stepName: 'add',
      });
    }
  });

  it('replays a completed history with a terminal event', async () => {
    const workflowRun = await createWorkflowRun();
    const workflowCode = createWorkflowCode();
    const correlationId = await discoverStepCorrelationId(
      workflowRun,
      workflowCode
    );
    const stepResult = await dehydrateStepReturnValue(
      3,
      workflowRun.runId,
      noEncryptionKey
    );
    const events: Event[] = [
      createEvent(workflowRun, 0, {
        eventType: 'step_started',
        correlationId,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          stepName: 'add',
        },
      }),
      createEvent(workflowRun, 1, {
        eventType: 'step_completed',
        correlationId,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          stepName: 'add',
          result: stepResult,
        },
      }),
      createEvent(workflowRun, 2, {
        eventType: 'run_completed',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          output: stepResult,
        },
      }),
    ];

    const result = await replayWorkflowHistory({
      workflowCode,
      workflowRun,
      events,
      encryptionKey: noEncryptionKey,
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.terminalEvent?.eventType).toBe('run_completed');
      await expect(
        hydrateWorkflowReturnValue(
          result.output,
          workflowRun.runId,
          noEncryptionKey
        )
      ).resolves.toBe(3);
    }
  });

  it('throws when an event with the expected correlation id has the wrong step name', async () => {
    const workflowRun = await createWorkflowRun();
    const workflowCode = createWorkflowCode();
    const correlationId = await discoverStepCorrelationId(
      workflowRun,
      workflowCode
    );

    await expect(
      replayWorkflowHistory({
        workflowCode,
        workflowRun,
        events: [
          createEvent(workflowRun, 0, {
            eventType: 'step_completed',
            correlationId,
            specVersion: SPEC_VERSION_CURRENT,
            eventData: {
              stepName: 'subtract',
              result: await dehydrateStepReturnValue(
                3,
                workflowRun.runId,
                noEncryptionKey
              ),
            },
          }),
        ],
        encryptionKey: noEncryptionKey,
      })
    ).rejects.toBeInstanceOf(CorruptedEventLogError);
  });

  it('throws when a history contains events for another run', async () => {
    const workflowRun = await createWorkflowRun();
    const workflowCode = createWorkflowCode();

    await expect(
      replayWorkflowHistory({
        workflowCode,
        workflowRun,
        events: [
          {
            ...createEvent(workflowRun, 0, {
              eventType: 'run_started',
              specVersion: SPEC_VERSION_CURRENT,
            }),
            runId: 'wrun_other',
          },
        ],
      })
    ).rejects.toBeInstanceOf(CorruptedEventLogError);
  });

  it('throws when a non-terminal event appears after a terminal event', async () => {
    const workflowRun = await createWorkflowRun();
    const workflowCode = createWorkflowCode();

    await expect(
      replayWorkflowHistory({
        workflowCode,
        workflowRun,
        events: [
          createEvent(workflowRun, 0, {
            eventType: 'run_completed',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: {},
          }),
          createEvent(workflowRun, 1, {
            eventType: 'run_started',
            specVersion: SPEC_VERSION_CURRENT,
          }),
        ],
      })
    ).rejects.toBeInstanceOf(CorruptedEventLogError);
  });
});
