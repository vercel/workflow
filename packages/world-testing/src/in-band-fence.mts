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
    'declares the in-band fence and lists a snapshot',
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
      await vi.waitFor(
        async () => {
          expect((await server.getRun(result.runId)).status).toBe('completed');
        },
        { interval: 200, timeout: 25_000 }
      );

      // A full listing covers every position up to the snapshot's `seq`, and a
      // settled run's log holds them all. `run_created` and the orchestrator's
      // own writes are in-band, so the count is at least 1 and at most `seq`.
      const events = await server.getEvents(result.runId);
      const snapshot = await server.getEventLogSnapshot(result.runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.seq).toBe(eventIdToSlot(events.at(-1)?.eventId ?? ''));
      expect(snapshot?.seqInBand).toBeGreaterThanOrEqual(1);
      expect(snapshot?.seqInBand).toBeLessThanOrEqual(snapshot?.seq ?? 0);
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
