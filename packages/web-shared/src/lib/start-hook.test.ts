import type { Event, EventType, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { otelTimeToMs } from '../components/workflow-traces/trace-time-utils';
import { analyzeEvents } from './event-analysis';
import { materializeHooks } from './event-materialization';
import { findStartHookCreation } from './start-hook';
import { buildTrace } from './trace-builder';

const RUN_ID = 'wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const START_HOOK_ID = 'hook_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TOKEN = 'start-token';
const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

let slot = 0;

function event(
  eventType: EventType,
  at: number,
  {
    correlationId,
    eventData = {},
  }: { correlationId?: string; eventData?: Record<string, unknown> } = {}
): Event {
  slot += 1;
  return {
    eventId: `evnt_${String(slot).padStart(26, '0')}`,
    runId: RUN_ID,
    eventType,
    correlationId,
    createdAt: new Date(BASE_TIME + at * 1000),
    occurredAt: new Date(BASE_TIME + at * 1000),
    eventData,
    specVersion: 8,
  } as unknown as Event;
}

const run = {
  runId: RUN_ID,
  workflowName: 'workflow//./workflows/demo//demo',
  status: 'completed',
  createdAt: new Date(BASE_TIME),
  completedAt: new Date(BASE_TIME + 60_000),
} as unknown as WorkflowRun;

/** The shape of a start Hook run's log: deliveries but no `hook_created`. */
function startHookRunLog(): Event[] {
  slot = 0;
  return [
    event('run_created', 0, {
      correlationId: RUN_ID,
      eventData: { startHook: { token: TOKEN, hookId: START_HOOK_ID } },
    }),
    event('hook_received', 1, { correlationId: START_HOOK_ID }),
    event('run_started', 1),
    event('hook_received', 2, { correlationId: START_HOOK_ID }),
    event('run_completed', 60),
  ];
}

describe('start Hook', () => {
  it('builds a span for a start Hook from its deliveries', () => {
    const trace = buildTrace(
      run,
      startHookRunLog(),
      new Date(BASE_TIME + 61_000),
      {
        isCompleteHistory: true,
      }
    );

    const hookSpans = trace.spans.filter((span) => span.resource === 'hook');
    expect(hookSpans).toHaveLength(1);
    const [hookSpan] = hookSpans;
    expect(hookSpan.spanId).toBe(START_HOOK_ID);
    expect(hookSpan.name).toBe(TOKEN);
    expect(otelTimeToMs(hookSpan.startTime)).toBe(BASE_TIME);
    expect(hookSpan.events.map((spanEvent) => spanEvent.name)).toEqual([
      'hook_received',
      'hook_received',
    ]);
    expect(hookSpan.attributes.data).toMatchObject({
      hookId: START_HOOK_ID,
      token: TOKEN,
      receivedCount: 2,
    });
  });

  it('builds a span for a start Hook nothing was delivered to yet', () => {
    slot = 0;
    const events = [
      event('run_created', 0, {
        correlationId: RUN_ID,
        eventData: { startHook: { token: TOKEN, hookId: START_HOOK_ID } },
      }),
      event('run_started', 1),
    ];
    const trace = buildTrace(
      { ...run, status: 'running', completedAt: undefined } as WorkflowRun,
      events,
      new Date(BASE_TIME + 5000)
    );

    expect(
      trace.spans
        .filter((span) => span.resource === 'hook')
        .map((s) => s.spanId)
    ).toEqual([START_HOOK_ID]);
  });

  it('ends a start Hook span at its disposal', () => {
    const events = startHookRunLog();
    events.splice(
      4,
      0,
      event('hook_disposed', 10, { correlationId: START_HOOK_ID })
    );
    const trace = buildTrace(run, events, new Date(BASE_TIME + 61_000));
    const [hookSpan] = trace.spans.filter((span) => span.resource === 'hook');

    expect(otelTimeToMs(hookSpan.endTime)).toBe(BASE_TIME + 10_000);
  });

  it('recognizes a start Hook listed without event data by its id', () => {
    const events = startHookRunLog().map(
      (e) => ({ ...e, eventData: undefined }) as unknown as Event
    );

    expect(findStartHookCreation(events)).toEqual({
      hookId: START_HOOK_ID,
      runId: RUN_ID,
      token: undefined,
      createdAt: new Date(BASE_TIME),
    });
  });

  it('finds no start Hook on a run started without one', () => {
    slot = 0;
    const events = [
      event('run_created', 0, { correlationId: RUN_ID }),
      event('run_started', 1),
      event('hook_created', 2, {
        correlationId: 'hook_other',
        eventData: { token: 'other' },
      }),
    ];

    expect(findStartHookCreation(events, run)).toBeUndefined();
    const trace = buildTrace(run, events, new Date(BASE_TIME + 5000));
    expect(
      trace.spans
        .filter((span) => span.resource === 'hook')
        .map((s) => s.spanId)
    ).toEqual(['hook_other']);
  });

  it('materializes a start Hook', () => {
    expect(materializeHooks(startHookRunLog())).toMatchObject([
      {
        hookId: START_HOOK_ID,
        runId: RUN_ID,
        token: TOKEN,
        createdAt: new Date(BASE_TIME),
        receivedCount: 2,
      },
    ]);
  });

  it('counts an undisposed start Hook as pending', () => {
    expect(analyzeEvents(startHookRunLog().slice(0, 4))).toMatchObject({
      hasPendingHooks: true,
      pendingHookIds: [START_HOOK_ID],
    });
  });
});
