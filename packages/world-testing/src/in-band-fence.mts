import { eventIdToSlot } from '@workflow/world';
import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

/**
 * The in-band writer fence every World implements: the runtime refuses a World
 * that does not declare it, and relies on it to keep a run to one writer when
 * two orchestrator deliveries overlap. A World can run every workflow in this
 * suite without the fence ever refusing anything, because the queue rarely
 * lets two deliveries of a run overlap, so the fence is checked directly here.
 * See the single-writer section of the building-a-world guide.
 */
export function inBandFence(world: string) {
  test(
    "declares the in-band fence and reports a run's counters",
    { timeout: 30_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);
      expect(await server.getCapabilities()).toMatchObject({
        inBandFence: true,
      });

      const result = await server.invoke(
        'workflows/addition.ts',
        'addition',
        [1, 2]
      );
      // Settled once `run_completed` is in the log. The run's status alone is
      // not enough: a World may show the terminal status before the terminal
      // event is listable.
      await vi.waitFor(
        async () => {
          const listed = await server.getEvents(result.runId);
          expect(listed.map((event) => event.eventType)).toContain(
            'run_completed'
          );
        },
        { interval: 200, timeout: 25_000 }
      );

      // Read the counters first: a late step completion may still append an
      // event after the run becomes terminal. The later full listing must
      // cover every position up to the counters' `seq`. `run_created` and the
      // orchestrator's own writes are in-band, so the count is at least 1 and at most `seq`.
      // The counters come from the list snapshot, or from a refusal where the
      // World lists none.
      const counters = await server.getFenceCounters(result.runId);
      const events = await server.getEvents(result.runId);
      expect(counters).not.toBeNull();
      expect(events.map((event) => eventIdToSlot(event.eventId))).toContain(
        counters?.seq
      );
      expect(counters?.seqInBand).toBeGreaterThanOrEqual(1);
      expect(counters?.seqInBand).toBeLessThanOrEqual(counters?.seq ?? 0);
    }
  );

  test(
    'refuses a stale in-band write before writing anything',
    { timeout: 30_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);
      const probe = await server.probeFence();

      expect(probe.atCreation).not.toBeNull();
      expect(probe.refusal).toEqual({
        name: 'InBandSupersededError',
        status: 412,
      });
      // Nothing was allocated for the refused write.
      expect(probe.afterRefusal).toEqual(probe.atCreation);
      // The write at the current count takes the very next position, and moves
      // both counters by one.
      const before = probe.atCreation ?? { seq: 0, seqInBand: 0 };
      expect(eventIdToSlot(probe.acceptedEventId ?? '')).toBe(before.seq + 1);
      expect(probe.afterAccept).toEqual({
        seq: before.seq + 1,
        seqInBand: before.seqInBand + 1,
      });
    }
  );
}
