import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { appendUniqueEvents } from './append-unique-events.js';

const makeEvent = (eventId: string): Event =>
  ({
    eventId,
    runId: 'wrun_mockidnumber0001',
    eventType: 'step_created',
    correlationId: 'step_mock',
    createdAt: new Date(),
  }) as unknown as Event;

describe('appendUniqueEvents', () => {
  it('preserves existing entries and appends only the first new event ID in source order', () => {
    const existing = makeEvent('evnt_existing');
    const duplicateExisting = makeEvent('evnt_existing');
    const firstNew = makeEvent('evnt_first-new');
    const duplicateNew = makeEvent('evnt_first-new');
    const secondNew = makeEvent('evnt_second-new');
    const events = [existing, duplicateExisting];

    appendUniqueEvents(events, [
      duplicateExisting,
      firstNew,
      duplicateNew,
      secondNew,
    ]);

    expect(events).toEqual([existing, duplicateExisting, firstNew, secondNew]);
    expect(events[0]).toBe(existing);
    expect(events[1]).toBe(duplicateExisting);
    expect(events[2]).toBe(firstNew);
    expect(events[3]).toBe(secondNew);
  });

  it('updates supplied known target IDs while merging multiple pages', () => {
    const existing = makeEvent('evnt_existing');
    const events = [existing];
    const knownTargetIds = new Set(events.map((event) => event.eventId));
    const pageOne = makeEvent('evnt_page-one');
    const pageTwo = makeEvent('evnt_page-two');

    appendUniqueEvents(events, [pageOne], knownTargetIds);
    appendUniqueEvents(events, [pageOne, pageTwo], knownTargetIds);

    expect(events).toEqual([existing, pageOne, pageTwo]);
    expect(knownTargetIds).toEqual(
      new Set(['evnt_existing', 'evnt_page-one', 'evnt_page-two'])
    );
  });
});
