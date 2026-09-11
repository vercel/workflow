import type { Event, EventType, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { otelTimeToMs } from '../components/workflow-traces/trace-time-utils';
import { buildTrace, filterSpanRawEvents } from './trace-builder';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

let nextId = 0;

function event(
  eventType: EventType,
  options: {
    correlationId?: string;
    at: number;
    externalAttemptId?: string;
  }
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
    externalAttemptId: options.externalAttemptId,
  } as unknown as Event;
}

const run = {
  runId: 'run_1',
  workflowName: 'demo',
  status: 'running',
  createdAt: new Date(BASE_TIME),
} as unknown as WorkflowRun;

describe('buildTrace', () => {
  it('adds caller-derived attributes to step span data', () => {
    const events = [
      event('run_created', { at: 0 }),
      event('run_started', { at: 0 }),
      event('step_created', { correlationId: 'step_a', at: 1 }),
      event('step_started', {
        correlationId: 'step_a',
        at: 2,
        externalAttemptId: 'attempt_first',
      }),
      event('step_retrying', { correlationId: 'step_a', at: 3 }),
      event('step_started', {
        correlationId: 'step_a',
        at: 4,
        externalAttemptId: 'attempt_latest',
      }),
    ];

    const trace = buildTrace(run, events, new Date(BASE_TIME + 5000), {
      getStepAttributes(stepEvents) {
        const latestStart = stepEvents
          .slice()
          .reverse()
          .find((candidate) => candidate.eventType === 'step_started') as
          | (Event & { externalAttemptId?: string })
          | undefined;
        return { externalAttemptId: latestStart?.externalAttemptId };
      },
    });
    const stepSpan = trace.spans.find((span) => span.resource === 'step');

    expect(stepSpan?.attributes.data).toMatchObject({
      externalAttemptId: 'attempt_latest',
    });
  });

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

    const trace = buildTrace(run, events, new Date(BASE_TIME + 30_000), {
      isCompleteHistory: true,
    });
    const stepSpan = trace.spans.find((span) => span.resource === 'step');

    expect(stepSpan).toBeDefined();
    expect(otelTimeToMs(stepSpan?.endTime ?? [0, 0])).toBe(BASE_TIME + 4000);
    expect(trace.knownDurationMs).toBe(4000);
  });

  it('keeps every event in the geometry when the log may be incomplete', () => {
    const events = [
      event('run_created', { at: 0 }),
      event('run_started', { at: 0 }),
      event('step_created', { correlationId: 'step_a', at: 1 }),
      event('step_started', { correlationId: 'step_a', at: 1 }),
      event('step_completed', { correlationId: 'step_a', at: 4 }),
      event('step_completed', { correlationId: 'step_a', at: 20 }),
    ];

    // Without the whole log there is no telling which of the two completions
    // the run acted on, so neither is dropped and the span covers both.
    const trace = buildTrace(run, events, new Date(BASE_TIME + 30_000));
    const stepSpan = trace.spans.find((span) => span.resource === 'step');

    expect(otelTimeToMs(stepSpan?.endTime ?? [0, 0])).toBe(BASE_TIME + 20_000);
    expect(trace.duplicateEventIds.size).toBe(0);
  });

  it('keeps sealed-position noops out of the geometry and its time bounds', () => {
    const events = [
      event('run_created', { at: 0 }),
      event('run_started', { at: 0 }),
      event('step_created', { correlationId: 'step_a', at: 1 }),
      event('step_started', { correlationId: 'step_a', at: 1 }),
      event('step_completed', { correlationId: 'step_a', at: 4 }),
      // A hole sealed by a reader long after the run went quiet. Its
      // createdAt is the SEALER's clock — letting it into the geometry would
      // stretch the trace to the sealer's schedule.
      event('noop', { correlationId: 'noop_5', at: 300 }),
    ];

    const trace = buildTrace(run, events, new Date(BASE_TIME + 400_000), {
      isCompleteHistory: true,
    });

    // No span for the noop's correlationId, and the trace's known duration
    // ends at the last real event, not at the seal.
    expect(trace.spans.some((span) => span.spanId === 'noop_5')).toBe(false);
    expect(trace.knownDurationMs).toBe(4000);

    // The run span's raw event list still shows the seal (greyed in the UI),
    // exactly like duplicate rows: real log rows, marked with the reason.
    const runRaw = filterSpanRawEvents(events, 'run', 'run_1');
    expect(runRaw.some((e) => e.eventType === 'noop')).toBe(true);
  });
});
