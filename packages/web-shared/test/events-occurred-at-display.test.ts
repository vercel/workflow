import type { Event } from '@workflow/world';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventRow } from '../src/components/event-list-view.js';
import { EventsList } from '../src/components/sidebar/events-list.js';

describe('event occurredAt display', () => {
  it('uses occurrence time as the created timestamp in detail panel rows by default', () => {
    const events = [
      {
        eventId: 'evnt_run_created',
        runId: 'wrun_occurred_at_test',
        eventType: 'run_created',
        createdAt: new Date(2026, 2, 16, 12, 34, 57),
        occurredAt: new Date(2026, 2, 16, 12, 34, 56),
        specVersion: 2,
        eventData: {
          deploymentId: 'dep_1',
          workflowName: 'occurred-at-workflow',
          input: {},
        },
      },
      {
        eventId: 'evnt_step_started',
        runId: 'wrun_occurred_at_test',
        eventType: 'step_started',
        correlationId: 'step_1',
        createdAt: new Date(2026, 2, 16, 12, 35, 2),
        occurredAt: new Date(2026, 2, 16, 12, 35, 1),
        specVersion: 2,
      },
    ] as Event[];

    const markup = renderToStaticMarkup(createElement(EventsList, { events }));

    expect(markup).not.toContain('Occurred');
    expect(markup).toContain('12:34:56');
    expect(markup).toContain('12:35:01');
    expect(markup).toContain('evnt_run_created');
    expect(markup).toContain('evnt_step_started');
  });

  it('shows separate occurrence rows in the detail panel when enabled', () => {
    const events = [
      {
        eventId: 'evnt_run_created',
        runId: 'wrun_occurred_at_test',
        eventType: 'run_created',
        createdAt: new Date('2026-03-16T00:00:01.000Z'),
        occurredAt: new Date('2026-03-16T00:00:00.050Z'),
        specVersion: 2,
      },
      {
        eventId: 'evnt_step_started',
        runId: 'wrun_occurred_at_test',
        eventType: 'step_started',
        correlationId: 'step_1',
        createdAt: new Date('2026-03-16T00:00:02.000Z'),
        occurredAt: new Date('2026-03-16T00:00:01.750Z'),
        specVersion: 2,
      },
    ] as Event[];

    const markup = renderToStaticMarkup(
      createElement(EventsList, {
        events,
        showSeparateEventOccurrenceTimestamps: true,
      })
    );

    expect(markup.match(/Occurred/g)).toHaveLength(2);
    expect(markup).toContain('evnt_run_created');
    expect(markup).toContain('evnt_step_started');
  });

  it('uses occurrence time as the created timestamp in each Events tab row by default', () => {
    const event = {
      eventId: 'evnt_run_created',
      runId: 'wrun_occurred_at_test',
      eventType: 'run_created',
      createdAt: new Date(2026, 2, 16, 12, 34, 57, 123),
      occurredAt: new Date(2026, 2, 16, 12, 34, 56, 789),
      specVersion: 2,
    } as Event;

    const markup = renderToStaticMarkup(
      createElement(EventRow, {
        event,
        index: 0,
        isFirst: true,
        isLast: true,
        isExpanded: false,
        onToggleExpand: () => {},
        selectedGroupRange: null,
        correlationNameMap: new Map(),
        workflowName: 'occurred-at-workflow',
        durationMap: new Map(),
        onSelectGroup: () => {},
        onHoverGroup: () => {},
        cachedEventData: null,
        onCacheEventData: () => {},
      })
    );

    expect(markup).toContain('12:34:56.789');
    expect(markup).not.toContain('12:34:57.123');
  });

  it('shows separate occurrence and created times in each Events tab row when enabled', () => {
    const event = {
      eventId: 'evnt_run_created',
      runId: 'wrun_occurred_at_test',
      eventType: 'run_created',
      createdAt: new Date(2026, 2, 16, 12, 34, 57, 123),
      occurredAt: new Date(2026, 2, 16, 12, 34, 56, 789),
      specVersion: 2,
    } as Event;

    const markup = renderToStaticMarkup(
      createElement(EventRow, {
        event,
        index: 0,
        isFirst: true,
        isLast: true,
        isExpanded: false,
        onToggleExpand: () => {},
        selectedGroupRange: null,
        correlationNameMap: new Map(),
        workflowName: 'occurred-at-workflow',
        durationMap: new Map(),
        onSelectGroup: () => {},
        onHoverGroup: () => {},
        cachedEventData: null,
        onCacheEventData: () => {},
        showSeparateEventOccurrenceTimestamps: true,
      })
    );

    expect(markup).toContain('12:34:56.789');
    expect(markup).toContain('12:34:57.123');
  });

  it('omits the detail panel occurrence row for events without occurredAt', () => {
    const events = [
      {
        eventId: 'evnt_run_created',
        runId: 'wrun_no_occurred_at_test',
        eventType: 'run_created',
        createdAt: new Date('2026-03-16T00:00:01.000Z'),
        specVersion: 2,
      },
    ] as Event[];

    const markup = renderToStaticMarkup(createElement(EventsList, { events }));

    expect(markup).not.toContain('Occurred');
  });
});
