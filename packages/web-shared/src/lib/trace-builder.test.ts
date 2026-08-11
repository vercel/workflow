import type { Event, EventType, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { otelTimeToMs } from '../components/workflow-traces/trace-time-utils';
import { buildTrace } from './trace-builder';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

let nextId = 0;

function event(
  eventType: EventType,
  options: { correlationId?: string; at: number }
): Event {
  nextId += 1;
  return {
    eventId: `evt_${nextId}`,
    runId: 'run_1',
    eventType,
    correlationId: options.correlationId,
    createdAt: new Date(BASE_TIME + options.at * 1000),
    occurredAt: new Date(BASE_TIME + options.at * 1000),
    eventData: eventType === 'step_created' ? { stepName: 'doWork' } : {},
  } as unknown as Event;
}

const run = {
  runId: 'run_1',
  workflowName: 'demo',
  status: 'running',
  createdAt: new Date(BASE_TIME),
} as unknown as WorkflowRun;

describe('buildTrace', () => {
  it('ends a step span on the terminal event the run acted on', () => {
    const events = [
      event('run_created', { at: 0 }),
      event('run_started', { at: 0 }),
      event('step_created', { correlationId: 'step_a', at: 1 }),
      event('step_started', { correlationId: 'step_a', at: 1 }),
      event('step_completed', { correlationId: 'step_a', at: 4 }),
      // A concurrent replay commits the same outcome much later. Measuring the
      // span against it would report a 20s step that ran for 3s.
      event('step_completed', { correlationId: 'step_a', at: 20 }),
    ];

    const trace = buildTrace(run, events, new Date(BASE_TIME + 30_000));
    const stepSpan = trace.spans.find((span) => span.resource === 'step');

    expect(stepSpan).toBeDefined();
    expect(otelTimeToMs(stepSpan?.endTime ?? [0, 0])).toBe(BASE_TIME + 4000);
    expect(trace.knownDurationMs).toBe(4000);
  });
});
