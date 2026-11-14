import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { DUPLICATE_EVENT_MESSAGE } from '../src/lib/duplicate-events.js';
import {
  buildEventLookups,
  buildEventRow,
} from '../src/lib/event-list-model.js';

const stepFailed = {
  eventId: 'evnt_step_failed',
  eventType: 'step_failed',
  correlationId: 'step_1',
  createdAt: new Date(2026, 0, 1),
} as Event;

describe('buildEventRow', () => {
  it('tints a failure, and mutes the same event as a duplicate', () => {
    const row = (duplicateEventIds: Set<string>) =>
      buildEventRow(
        stepFailed,
        buildEventLookups([stepFailed], null, duplicateEventIds)
      );

    expect(row(new Set())).toMatchObject({
      level: 'error',
      message: 'failed',
      notice: undefined,
    });
    expect(row(new Set([stepFailed.eventId]))).toMatchObject({
      level: 'muted',
      message: 'duplicate, ignored on replay',
      notice: DUPLICATE_EVENT_MESSAGE,
    });
  });
});
