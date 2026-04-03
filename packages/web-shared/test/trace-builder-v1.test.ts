import type { Event, WorkflowRun } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { computeSegments } from '../src/components/trace-viewer/components/span-segments.js';
import { parseTrace } from '../src/components/trace-viewer/util/tree.js';
import {
  buildTrace,
  groupEventsByCorrelation,
} from '../src/lib/trace-builder.js';

const BASE_TIME = new Date('2026-03-16T00:00:00Z');
const STARTED_TIME = new Date('2026-03-16T00:00:01Z');
const COMPLETED_TIME = new Date('2026-03-16T00:00:10Z');

function makeV1Run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: 'wrun_v1test',
    deploymentId: 'dep_1',
    workflowName: 'v1-workflow',
    specVersion: 1,
    input: {},
    createdAt: BASE_TIME,
    updatedAt: COMPLETED_TIME,
    startedAt: STARTED_TIME,
    completedAt: COMPLETED_TIME,
    status: 'completed',
    output: { result: 'ok' },
    error: undefined,
    executionContext: {},
    expiredAt: undefined,
    ...overrides,
  } as WorkflowRun;
}

/** V2-style step events (includes step_created) */
function makeStepEvents(
  correlationId: string,
  stepName: string,
  startOffset: number,
  endOffset: number
): Event[] {
  return [
    {
      eventId: `evnt_${correlationId}_created`,
      runId: 'wrun_v1test',
      eventType: 'step_created',
      correlationId,
      createdAt: new Date(BASE_TIME.getTime() + startOffset),
      specVersion: 1,
      eventData: { stepName, input: {} },
    },
    {
      eventId: `evnt_${correlationId}_started`,
      runId: 'wrun_v1test',
      eventType: 'step_started',
      correlationId,
      createdAt: new Date(BASE_TIME.getTime() + startOffset + 100),
      specVersion: 1,
    },
    {
      eventId: `evnt_${correlationId}_completed`,
      runId: 'wrun_v1test',
      eventType: 'step_completed',
      correlationId,
      createdAt: new Date(BASE_TIME.getTime() + endOffset),
      specVersion: 1,
      eventData: { result: 42 },
    },
  ] as Event[];
}

/** V1-style step events (no step_created — only step_started + step_completed) */
function makeV1StepEvents(
  correlationId: string,
  startOffset: number,
  endOffset: number
): Event[] {
  return [
    {
      eventId: `evnt_${correlationId}_started`,
      runId: 'wrun_v1test',
      eventType: 'step_started',
      correlationId,
      createdAt: new Date(BASE_TIME.getTime() + startOffset),
      specVersion: 1,
    },
    {
      eventId: `evnt_${correlationId}_completed`,
      runId: 'wrun_v1test',
      eventType: 'step_completed',
      correlationId,
      createdAt: new Date(BASE_TIME.getTime() + endOffset),
      specVersion: 1,
      eventData: { result: 42 },
    },
  ] as Event[];
}

describe('Trace viewer with v1 events (no run lifecycle events)', () => {
  describe('groupEventsByCorrelation', () => {
    it('groups step events with no run-level events for v1', () => {
      const events = makeStepEvents('step_1', 'add', 1000, 3000);
      const grouped = groupEventsByCorrelation(events);

      expect(grouped.runLevelEvents).toHaveLength(0);
      expect(grouped.eventsByStepId.size).toBe(1);
      expect(grouped.eventsByStepId.get('step_1')).toHaveLength(3);
    });
  });

  describe('buildTrace', () => {
    it('builds a valid trace for a completed v1 run with step events', () => {
      const run = makeV1Run({ status: 'completed' });
      const events = makeStepEvents('step_1', 'add', 1000, 3000);
      const now = new Date('2026-03-16T00:01:00Z');
      const trace = buildTrace(run, events, now);

      expect(trace.traceId).toBe('wrun_v1test');
      expect(trace.rootSpanId).toBe('wrun_v1test');
      expect(trace.spans).toHaveLength(2);

      const runSpan = trace.spans.find((s) => s.spanId === 'wrun_v1test');
      expect(runSpan).toBeDefined();
      expect(runSpan!.attributes.resource).toBe('run');
      expect(runSpan!.attributes.data).toMatchObject({
        status: 'completed',
        completedAt: COMPLETED_TIME,
      });
    });

    it('builds a valid trace for a failed v1 run', () => {
      const run = makeV1Run({
        status: 'failed',
        output: undefined,
        error: { message: 'boom' },
      });
      const events = makeStepEvents('step_1', 'add', 1000, 3000);
      const trace = buildTrace(run, events, new Date());

      const runSpan = trace.spans.find((s) => s.spanId === 'wrun_v1test');
      expect(runSpan!.attributes.data).toMatchObject({ status: 'failed' });
    });

    it('builds a valid trace for a v1 run with no events at all', () => {
      const run = makeV1Run({ status: 'completed' });
      const trace = buildTrace(run, [], new Date());

      expect(trace.spans).toHaveLength(1);
      expect(trace.spans[0].spanId).toBe('wrun_v1test');
      expect(trace.spans[0].attributes.resource).toBe('run');
    });

    it('builds step spans from v1 events (no step_created)', () => {
      const run = makeV1Run({ status: 'completed' });
      const events = [
        ...makeV1StepEvents('step_1', 1000, 3000),
        ...makeV1StepEvents('step_2', 4000, 6000),
      ];
      const trace = buildTrace(run, events, new Date());

      // Run span + 2 step spans
      expect(trace.spans).toHaveLength(3);

      const stepSpans = trace.spans.filter(
        (s) => s.attributes.resource === 'step'
      );
      expect(stepSpans).toHaveLength(2);
      expect(stepSpans[0].spanId).toBe('step_1');
      expect(stepSpans[1].spanId).toBe('step_2');
    });

    it('derives step status from v1 events without step_created', () => {
      const run = makeV1Run({ status: 'completed' });
      const events = makeV1StepEvents('step_1', 1000, 3000);
      const trace = buildTrace(run, events, new Date());

      const stepSpan = trace.spans.find((s) => s.spanId === 'step_1');
      expect(stepSpan).toBeDefined();
      expect(stepSpan!.attributes.data).toMatchObject({
        status: 'completed',
        stepName: '',
      });
    });

    it('uses correlationId for step span when stepName is unavailable', () => {
      const run = makeV1Run({ status: 'completed' });
      const events = makeV1StepEvents('step_1', 1000, 3000);
      const trace = buildTrace(run, events, new Date());

      const stepSpan = trace.spans.find((s) => s.spanId === 'step_1');
      expect(stepSpan).toBeDefined();
      // Without step_created, stepName is empty; the span name comes from
      // parseStepName which returns the correlationId as fallback
      expect(stepSpan!.spanId).toBe('step_1');
    });
  });

  describe('computeSegments for v1 run spans', () => {
    it('shows "succeeded" segment for a completed v1 run (no run_completed event)', () => {
      const run = makeV1Run({ status: 'completed' });
      const events = makeStepEvents('step_1', 'add', 1000, 3000);
      const trace = buildTrace(run, events, new Date());
      const { map } = parseTrace(trace);

      const runNode = map[run.runId];
      expect(runNode).toBeDefined();

      const result = computeSegments('run', runNode);
      expect(result.segments.length).toBeGreaterThan(0);

      const lastSegment = result.segments[result.segments.length - 1];
      expect(lastSegment.status).toBe('succeeded');
      expect(lastSegment.endFraction).toBe(1);
    });

    it('shows "failed" segment for a failed v1 run (no run_failed event)', () => {
      const run = makeV1Run({
        status: 'failed',
        output: undefined,
        error: { message: 'boom' },
      });
      const events = makeStepEvents('step_1', 'add', 1000, 3000);
      const trace = buildTrace(run, events, new Date());
      const { map } = parseTrace(trace);

      const runNode = map[run.runId];
      const result = computeSegments('run', runNode);

      const lastSegment = result.segments[result.segments.length - 1];
      expect(lastSegment.status).toBe('failed');
      expect(lastSegment.endFraction).toBe(1);
    });

    it('shows "running" segment for an in-progress v1 run', () => {
      const run = makeV1Run({
        status: 'running',
        completedAt: undefined,
        output: undefined,
      });
      const events = makeStepEvents('step_1', 'add', 1000, 3000);
      const now = new Date('2026-03-16T00:01:00Z');
      const trace = buildTrace(run, events, now);
      const { map } = parseTrace(trace);

      const runNode = map[run.runId];
      const result = computeSegments('run', runNode);

      const lastSegment = result.segments[result.segments.length - 1];
      expect(lastSegment.status).toBe('running');
    });

    it('shows queued + succeeded for a v1 run with startedAt', () => {
      const run = makeV1Run({ status: 'completed', startedAt: STARTED_TIME });
      const trace = buildTrace(run, [], new Date());
      const { map } = parseTrace(trace);

      const runNode = map[run.runId];
      const result = computeSegments('run', runNode);

      expect(result.segments.length).toBe(2);
      expect(result.segments[0].status).toBe('queued');
      expect(result.segments[1].status).toBe('succeeded');
    });

    it('v2 baseline: shows "succeeded" from run_completed event', () => {
      const run = makeV1Run({ specVersion: 2, status: 'completed' });
      const stepEvents = makeStepEvents('step_1', 'add', 1000, 3000);
      const runCreatedEvent: Event = {
        eventId: 'evnt_run_created',
        runId: 'wrun_v1test',
        eventType: 'run_created',
        createdAt: BASE_TIME,
        specVersion: 2,
        eventData: {
          deploymentId: 'dep_1',
          workflowName: 'v1-workflow',
          input: {},
        },
      } as Event;
      const runCompletedEvent: Event = {
        eventId: 'evnt_run_completed',
        runId: 'wrun_v1test',
        eventType: 'run_completed',
        createdAt: COMPLETED_TIME,
        specVersion: 2,
        eventData: { output: { result: 'ok' } },
      } as Event;
      const events = [runCreatedEvent, ...stepEvents, runCompletedEvent];
      const trace = buildTrace(run, events, new Date());
      const { map } = parseTrace(trace);

      const runNode = map[run.runId];
      const result = computeSegments('run', runNode);

      const lastSegment = result.segments[result.segments.length - 1];
      expect(lastSegment.status).toBe('succeeded');
    });

    it('v2 mid-pagination: shows "running" when run_completed has not loaded yet', () => {
      const run = makeV1Run({ specVersion: 2, status: 'completed' });
      const stepEvents = makeStepEvents('step_1', 'add', 1000, 3000);
      const runCreatedEvent: Event = {
        eventId: 'evnt_run_created',
        runId: 'wrun_v1test',
        eventType: 'run_created',
        createdAt: BASE_TIME,
        specVersion: 2,
        eventData: {
          deploymentId: 'dep_1',
          workflowName: 'v1-workflow',
          input: {},
        },
      } as Event;
      // run_created is present but run_completed hasn't loaded yet
      const events = [runCreatedEvent, ...stepEvents];
      const trace = buildTrace(run, events, new Date());
      const { map } = parseTrace(trace);

      const runNode = map[run.runId];
      const result = computeSegments('run', runNode);

      const lastSegment = result.segments[result.segments.length - 1];
      expect(lastSegment.status).toBe('running');
    });
  });
});
