import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { otelTimeToMs } from '../src/components/workflow-traces/trace-time-utils.js';
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

describe('trace builder occurredAt timing', () => {
  it('uses event occurrence timestamps for step span timing when available', () => {
    const run = makeRun();
    const stepCreatedAt = new Date(BASE_TIME.getTime() + 1_000);
    const stepCreatedOccurredAt = new Date(BASE_TIME.getTime() + 1_050);
    const stepStartedAt = new Date(BASE_TIME.getTime() + 1_100);
    const stepStartedOccurredAt = new Date(BASE_TIME.getTime() + 1_250);
    const stepCompletedAt = new Date(BASE_TIME.getTime() + 3_000);
    const stepCompletedOccurredAt = new Date(BASE_TIME.getTime() + 2_750);
    const events = [
      {
        eventId: 'evnt_step_created',
        runId: run.runId,
        eventType: 'step_created',
        correlationId: 'step_1',
        createdAt: stepCreatedAt,
        occurredAt: stepCreatedOccurredAt,
        specVersion: 2,
        eventData: { stepName: 'add', input: {} },
      },
      {
        eventId: 'evnt_step_started',
        runId: run.runId,
        eventType: 'step_started',
        correlationId: 'step_1',
        createdAt: stepStartedAt,
        occurredAt: stepStartedOccurredAt,
        specVersion: 2,
      },
      {
        eventId: 'evnt_step_completed',
        runId: run.runId,
        eventType: 'step_completed',
        correlationId: 'step_1',
        createdAt: stepCompletedAt,
        occurredAt: stepCompletedOccurredAt,
        specVersion: 2,
        eventData: { result: 42 },
      },
    ] as Event[];

    const trace = buildTrace(
      run,
      events,
      new Date(BASE_TIME.getTime() + 10_000)
    );
    const stepSpan = trace.spans.find((s) => s.attributes.resource === 'step');
    expect(stepSpan).toBeDefined();
    if (!stepSpan) {
      throw new Error('Expected step span to be built');
    }

    expect(otelTimeToMs(stepSpan.startTime)).toBe(
      stepCreatedOccurredAt.getTime()
    );
    expect(stepSpan.activeStartTime).toBeDefined();
    if (!stepSpan.activeStartTime) {
      throw new Error('Expected step span active start time to be built');
    }
    expect(otelTimeToMs(stepSpan.activeStartTime)).toBe(
      stepStartedOccurredAt.getTime()
    );
    expect(otelTimeToMs(stepSpan.endTime)).toBe(
      stepCompletedOccurredAt.getTime()
    );
    expect(otelTimeToMs(stepSpan.duration)).toBe(
      stepCompletedOccurredAt.getTime() - stepCreatedOccurredAt.getTime()
    );

    const startMarker = stepSpan.events.find(
      (event) => event.name === 'step_started'
    );
    expect(startMarker).toBeDefined();
    if (!startMarker) {
      throw new Error('Expected step_started marker to be built');
    }
    expect(otelTimeToMs(startMarker.timestamp)).toBe(
      stepStartedOccurredAt.getTime()
    );
    const stepData = stepSpan.attributes.data as {
      createdAt: Date;
      startedAt?: Date;
      completedAt?: Date;
      occurredAt?: Date;
    };
    expect(stepData.createdAt).toEqual(stepCreatedOccurredAt);
    expect(stepData.startedAt).toEqual(stepStartedOccurredAt);
    expect(stepData.completedAt).toEqual(stepCompletedOccurredAt);
    expect(stepData).not.toHaveProperty('occurredAt');
  });
});
