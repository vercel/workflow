import {
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  slotToEventId,
} from '@workflow/world';
import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

/**
 * Event ids are positions.
 *
 * This is the one part of the storage contract a World can get wrong while
 * every other test in this suite passes. Nothing here reads an event id, so a
 * World that mints ULIDs runs an addition, resumes a hook and completes a run
 * exactly as it should — and then fails every replay on the deployment, with
 * `Event id is not slot-numbered`, because the runtime reads a position out of
 * each id it loads and cannot proceed without one.
 *
 * Asserting it here is the difference between a conformance failure a World
 * author can act on and a production failure nobody can explain. See the
 * Event ID Allocation section of the building-a-world guide.
 */
export function eventIds(world: string) {
  test('numbers events by position', { timeout: 30_000 }, async () => {
    const server = await startServer({ world }).then(createFetcher);
    const result = await server.invoke(
      'workflows/addition.ts',
      'addition',
      [1, 2]
    );
    await vi.waitFor(
      async () => {
        expect((await server.getRun(result.runId)).status).toBe('completed');
      },
      { interval: 200, timeout: 25_000 }
    );

    const events = await server.getEvents(result.runId);
    expect(events.length).toBeGreaterThan(0);

    // Every id decodes to a slot. `eventIdToSlot` answers null for anything
    // else, which is what `requireEventSlot` turns into a failed run.
    const slots = events.map((event) => ({
      eventId: event.eventId,
      slot: eventIdToSlot(event.eventId),
    }));
    expect(slots.filter((entry) => entry.slot === null)).toEqual([]);

    // Dense from 1, in the order the World returns them. Density is what lets
    // a reader tell a complete log from a truncated one by its length, and
    // what makes the writer's event count a statement of its position.
    expect(slots.map((entry) => entry.slot)).toEqual(
      slots.map((_, index) => FIRST_EVENT_SLOT + index)
    );

    // The canonical format, not merely something that decodes: a World that
    // pads to a different width sorts its own log wrongly past 10 events.
    expect(slots.map((entry) => entry.eventId)).toEqual(
      slots.map((entry) => slotToEventId(entry.slot as number))
    );
  });
}
