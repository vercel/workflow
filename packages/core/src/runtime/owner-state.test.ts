import type { Event, Step } from '@workflow/world';
import { expect, it } from 'vitest';
import { reduceStep, runFromCreation } from './owner-state.js';

const at = (ms: number) => new Date(ms);
const event = (fields: Record<string, unknown>) =>
  ({ runId: 'wrun_test', specVersion: 6, ...fields }) as unknown as Event;

it('derives the run from run_created', () => {
  const run = runFromCreation(
    event({
      eventId: 'evnt_1',
      eventType: 'run_created',
      createdAt: at(1),
      eventData: {
        deploymentId: 'dpl',
        workflowName: 'wf',
        input: Uint8Array.of(1),
        executionContext: { retainedRunnerVersion: 1 },
      },
    })
  );
  expect(run).toMatchObject({
    runId: 'wrun_test',
    status: 'pending',
    deploymentId: 'dpl',
    workflowName: 'wf',
    input: Uint8Array.of(1),
    executionContext: { retainedRunnerVersion: 1 },
    attributes: {},
    createdAt: at(1),
  });
  expect(() =>
    runFromCreation(event({ eventType: 'run_started', createdAt: at(1) }))
  ).toThrow('run_created');
});

it('reduces Step transitions with event time', () => {
  const steps = new Map<string, Step>();
  const step = (eventType: string, ms: number, eventData = {}) =>
    reduceStep(
      steps,
      event({
        eventType,
        correlationId: 'step_a',
        createdAt: at(ms),
        eventData,
      })
    );
  step('step_created', 1, { stepName: 's', input: Uint8Array.of(1) });
  step('step_started', 2);
  step('step_retrying', 3, { error: Uint8Array.of(2), retryAfter: at(10) });
  expect(steps.get('step_a')).toMatchObject({
    status: 'pending',
    attempt: 1,
    startedAt: at(2),
    retryAfter: at(10),
  });
  step('step_started', 11);
  step('step_completed', 12, { result: Uint8Array.of(3) });
  expect(steps.get('step_a')).toMatchObject({
    status: 'completed',
    attempt: 2,
    startedAt: at(2),
    output: Uint8Array.of(3),
    completedAt: at(12),
    createdAt: at(1),
    updatedAt: at(12),
  });
  expect(steps.get('step_a')?.retryAfter).toBeUndefined();
  expect(() => step('step_created', 13, { stepName: 's' })).toThrow(
    'Duplicate'
  );
  reduceStep(
    steps,
    event({
      eventType: 'hook_created',
      correlationId: 'hook',
      createdAt: at(1),
    })
  );
  expect(steps.size).toBe(1);
});
