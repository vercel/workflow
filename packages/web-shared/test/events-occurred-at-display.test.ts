import type { Event } from '@workflow/world';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventRow } from '../src/components/event-list-view.js';
import { EventsList } from '../src/components/sidebar/events-list.js';

describe('event occurredAt display', () => {
  it('renders event occurrence time inside each detail panel event row', () => {
    const events = [
      {
        eventId: 'evnt_run_created',
        runId: 'wrun_occurred_at_test',
        eventType: 'run_created',
        createdAt: new Date('2026-03-16T00:00:01.000Z'),
        occurredAt: new Date('2026-03-16T00:00:00.050Z'),
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
        createdAt: new Date('2026-03-16T00:00:02.000Z'),
        occurredAt: new Date('2026-03-16T00:00:01.750Z'),
        specVersion: 2,
      },
    ] as Event[];

    const markup = renderToStaticMarkup(createElement(EventsList, { events }));

    expect(markup.match(/Occurred/g)).toHaveLength(2);
    expect(markup).toContain('evnt_run_created');
    expect(markup).toContain('evnt_step_started');
  });

  it('renders event occurrence time in each Events tab row', () => {
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

    expect(markup).toContain('12:34:57.123');
    expect(markup).toContain('12:34:56.789');
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
