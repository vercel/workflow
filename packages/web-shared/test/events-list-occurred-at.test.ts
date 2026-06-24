import type { Event } from '@workflow/world';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventsList } from '../src/components/sidebar/events-list.js';

describe('EventsList occurredAt metadata', () => {
  it('renders event occurrence time inside each event row', () => {
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

  it('omits the occurrence row for events without occurredAt', () => {
    const events = [
      {
        eventId: 'evnt_run_created',
        runId: 'wrun_no_occurred_at_test',
        eventType: 'run_created',
        createdAt: new Date('2026-03-16T00:00:01.000Z'),
        specVersion: 2,
        eventData: {
          deploymentId: 'dep_1',
          workflowName: 'no-occurred-at-workflow',
          input: {},
        },
      },
    ] as Event[];

    const markup = renderToStaticMarkup(createElement(EventsList, { events }));

    expect(markup).not.toContain('Occurred');
  });
});
