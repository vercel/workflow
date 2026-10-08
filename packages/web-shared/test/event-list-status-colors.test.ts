import type { Event, EventType } from '@workflow/world';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventRow } from '../src/components/event-list-view.js';

function renderEvent(eventType: EventType): string {
  const event = {
    eventId: `evnt_${eventType}`,
    runId: 'wrun_status_color_test',
    eventType,
    createdAt: new Date('2026-09-18T00:00:00.000Z'),
    specVersion: 2,
  } as Event;

  return renderToStaticMarkup(
    createElement(EventRow, {
      event,
      index: 0,
      isFirst: true,
      isLast: true,
      isExpanded: false,
      onToggleExpand: () => {},
      selectedGroupRange: null,
      correlationNameMap: new Map(),
      workflowName: 'status-color-workflow',
      durationMap: new Map(),
      onSelectGroup: () => {},
      onHoverGroup: () => {},
      cachedEventData: null,
      onCacheEventData: () => {},
    })
  );
}

describe('event list status colors', () => {
  it.each([
    ['run_completed', 'var(--geist-cyan, var(--ds-teal-700))'],
    ['run_failed', 'var(--geist-error, var(--ds-red-700))'],
    ['run_started', 'var(--geist-warning, var(--ds-amber-700))'],
    ['run_created', 'var(--ds-gray-500)'],
    ['run_cancelled', 'var(--ds-gray-500)'],
  ] as const)('renders %s with %s', (eventType, color) => {
    expect(renderEvent(eventType)).toContain(`background-color:${color}`);
  });
});
