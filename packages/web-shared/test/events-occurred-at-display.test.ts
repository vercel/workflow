import type { Event } from '@workflow/world';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventRow } from '../src/components/event-list/event-row.js';
import { EventsList } from '../src/components/sidebar/events-list.js';
import { TooltipProvider } from '../src/components/ui/tooltip.js';
import {
  buildEventLookups,
  buildEventRow,
} from '../src/lib/event-list-model.js';

const eventsTabEvent = {
  eventId: 'evnt_run_created',
  runId: 'wrun_occurred_at_test',
  eventType: 'run_created',
  createdAt: new Date(2026, 2, 16, 12, 34, 57, 123),
  occurredAt: new Date(2026, 2, 16, 12, 34, 56, 789),
  specVersion: 2,
} as Event;

function renderEventsTabRow(
  event: Event,
  options: { showSeparateEventOccurrenceTimestamps?: boolean } = {}
): string {
  const row = buildEventRow(event, buildEventLookups([event], null, new Set()));
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(EventRow, {
        row,
        index: 0,
        isSelected: false,
        isTabStop: true,
        isRelated: false,
        onSelect: () => {},
        ...options,
      })
    )
  );
}

/**
 * Every timestamp a row shows, in column order. Each is rendered as day,
 * clock and milliseconds in separate elements.
 */
function timestampsIn(markup: string): string[] {
  return [
    ...markup.matchAll(
      /<span[^>]*>([A-Z]{3} \d{2} )<\/span>(\d{2}:\d{2}:\d{2})<span[^>]*>(\.\d{3})<\/span>/g
    ),
  ].map(([, day, clock, ms]) => `${day}${clock}${ms}`);
}

describe('event occurredAt display', () => {
  it('omits cancellation reasons from sidebar event details', () => {
    const events = [
      {
        eventId: 'evnt_run_cancelled',
        runId: 'wrun_cancelled_test',
        eventType: 'run_cancelled',
        createdAt: new Date('2026-09-18T00:00:00.000Z'),
        specVersion: 2,
        eventData: { cancelReason: 'stopped by operator' },
      },
    ] as Event[];

    const markup = renderToStaticMarkup(createElement(EventsList, { events }));

    expect(markup).toContain('run_cancelled');
    expect(markup).not.toContain('stopped by operator');
  });

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
    const markup = renderEventsTabRow(eventsTabEvent);

    expect(timestampsIn(markup)).toEqual(['MAR 16 12:34:56.789']);
  });

  it('shows separate occurrence and created times in each Events tab row when enabled', () => {
    const markup = renderEventsTabRow(eventsTabEvent, {
      showSeparateEventOccurrenceTimestamps: true,
    });

    expect(timestampsIn(markup)).toEqual([
      'MAR 16 12:34:56.789',
      'MAR 16 12:34:57.123',
    ]);
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
