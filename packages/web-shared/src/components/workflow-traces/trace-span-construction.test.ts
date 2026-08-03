import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { runToSpan } from './trace-span-construction';
import { otelTimeToMs } from './trace-time-utils';

const date = (ms: number) => new Date(ms);

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: 'run_1',
    status: 'completed',
    deploymentId: 'dpl_1',
    workflowName: 'workflow//./workflow//testWorkflow',
    specVersion: 2,
    attributes: {},
    createdAt: date(1_000),
    updatedAt: date(6_000),
    startedAt: date(2_000),
    completedAt: date(6_000),
    output: null,
    ...overrides,
  } as WorkflowRun;
}

function event(overrides: Partial<Event>): Event {
  return {
    runId: 'run_1',
    eventId: `evt_${overrides.eventType ?? 'unknown'}`,
    eventType: 'run_created',
    createdAt: date(1_000),
    specVersion: 2,
    eventData: {
      deploymentId: 'dpl_1',
      workflowName: 'workflow//./workflow//testWorkflow',
      input: null,
    },
    ...overrides,
  } as Event;
}

describe('runToSpan', () => {
  it('prefers occurredAt for run span timing when available', () => {
    const span = runToSpan(
      run(),
      [
        event({
          eventType: 'run_created',
          createdAt: date(1_000),
          occurredAt: date(100),
        }),
        event({
          eventType: 'run_started',
          createdAt: date(2_000),
          occurredAt: date(200),
        }),
        event({
          eventType: 'run_completed',
          createdAt: date(6_000),
          occurredAt: date(500),
        }),
      ],
      date(10_000)
    );

    expect(otelTimeToMs(span.startTime)).toBe(100);
    expect(
      span.activeStartTime ? otelTimeToMs(span.activeStartTime) : undefined
    ).toBe(200);
    expect(otelTimeToMs(span.endTime)).toBe(500);
    expect(
      span.events.find((e) => e.name === 'run_created')?.timestamp
    ).toEqual([0, 100_000_000]);

    const data = span.attributes.data as {
      createdAt: Date;
      startedAt?: Date;
      completedAt?: Date;
      occurredAt?: Date;
    };
    expect(data.createdAt).toEqual(date(100));
    expect(data.startedAt).toEqual(date(200));
    expect(data.completedAt).toEqual(date(500));
    expect(data).not.toHaveProperty('occurredAt');
  });
});
