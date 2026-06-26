import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { materializeAll } from '../src/lib/event-materialization.js';
import { buildTrace } from '../src/lib/trace-builder.js';

const BASE_TIME = new Date('2026-03-16T00:00:00Z');

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: 'wrun_occurred_at_test',
    deploymentId: 'dep_1',
    workflowName: 'occurred-at-workflow',
    specVersion: 2,
    input: {},
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    startedAt: BASE_TIME,
    completedAt: undefined,
    status: 'running',
    output: undefined,
    error: undefined,
    executionContext: {},
    expiredAt: undefined,
    ...overrides,
  } as WorkflowRun;
}

describe('trace builder occurredAt data', () => {
  it('threads lifecycle event occurredAt into span and materialized entity data', () => {
    const run = makeRun();
    const runOccurredAt = new Date(BASE_TIME.getTime() + 50);
    const stepOccurredAt = new Date(BASE_TIME.getTime() + 1_050);
    const hookOccurredAt = new Date(BASE_TIME.getTime() + 2_050);
    const waitOccurredAt = new Date(BASE_TIME.getTime() + 3_050);
    const events = [
      {
        eventId: 'evnt_run_created',
        runId: run.runId,
        eventType: 'run_created',
        createdAt: BASE_TIME,
        occurredAt: runOccurredAt,
        specVersion: 2,
        eventData: {
          deploymentId: 'dep_1',
          workflowName: run.workflowName,
          input: {},
        },
      },
      {
        eventId: 'evnt_step_created',
        runId: run.runId,
        eventType: 'step_created',
        correlationId: 'step_1',
        createdAt: new Date(BASE_TIME.getTime() + 1_000),
        occurredAt: stepOccurredAt,
        specVersion: 2,
        eventData: { stepName: 'add', input: {} },
      },
      {
        eventId: 'evnt_step_started',
        runId: run.runId,
        eventType: 'step_started',
        correlationId: 'step_1',
        createdAt: new Date(BASE_TIME.getTime() + 1_100),
        specVersion: 2,
      },
      {
        eventId: 'evnt_hook_created',
        runId: run.runId,
        eventType: 'hook_created',
        correlationId: 'hook_1',
        createdAt: new Date(BASE_TIME.getTime() + 2_000),
        occurredAt: hookOccurredAt,
        specVersion: 2,
        eventData: { token: 'approve' },
      },
      {
        eventId: 'evnt_wait_created',
        runId: run.runId,
        eventType: 'wait_created',
        correlationId: 'wait_1',
        createdAt: new Date(BASE_TIME.getTime() + 3_000),
        occurredAt: waitOccurredAt,
        specVersion: 2,
        eventData: {
          resumeAt: new Date(BASE_TIME.getTime() + 60_000),
        },
      },
    ] as Event[];

    const trace = buildTrace(
      run,
      events,
      new Date(BASE_TIME.getTime() + 10_000)
    );
    const dataFor = (resource: string) => {
      const span = trace.spans.find((s) => s.attributes.resource === resource);
      expect(span).toBeDefined();
      return span?.attributes.data as { occurredAt?: Date } | undefined;
    };

    expect(dataFor('run')?.occurredAt).toEqual(runOccurredAt);
    expect(dataFor('step')?.occurredAt).toEqual(stepOccurredAt);
    expect(dataFor('hook')?.occurredAt).toEqual(hookOccurredAt);
    expect(dataFor('sleep')?.occurredAt).toEqual(waitOccurredAt);

    const materialized = materializeAll(events);
    expect(materialized.steps[0]?.occurredAt).toEqual(stepOccurredAt);
    expect(materialized.hooks[0]?.occurredAt).toEqual(hookOccurredAt);
    expect(materialized.waits[0]?.occurredAt).toEqual(waitOccurredAt);
  });
});
