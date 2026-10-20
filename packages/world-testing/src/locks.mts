import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

/**
 * `experimental_lock()` end to end through a World's real queue: never more holders than
 * `concurrency`, every scope's log holds at most one `lock_created` however
 * long it waited, and fencing tokens are distinct. Skipped for a World that
 * does not declare the `locks` capability. The storage-level contract is
 * checked in `@workflow/world`'s `test-support/lock-conformance.ts`.
 */
export function locks(world: string) {
  test(
    'experimental_lock(): admits at most `concurrency` holders, and waiting adds no events',
    { timeout: 120_000 },
    async (ctx) => {
      const server = await startServer({ world }).then(createFetcher);
      const capabilities = (await server.getCapabilities()) as {
        locks?: { concurrency?: boolean };
      };
      if (capabilities.locks?.concurrency !== true) {
        ctx.skip();
      }

      // Namespaced per test run: a shared tenant must never see two suites'
      // keys collide.
      const key = `world-testing:${randomUUID()}`;
      const concurrency = 2;
      const runs = await Promise.all(
        Array.from({ length: 6 }, () =>
          server.invoke('workflows/locks.ts', 'lockFanout', [
            key,
            concurrency,
            400,
          ])
        )
      );
      await vi.waitFor(
        async () => {
          for (const { runId } of runs) {
            expect((await server.getRun(runId)).status).toBe('completed');
          }
        },
        { interval: 250, timeout: 110_000 }
      );

      const windows: { start: number; end: number }[] = [];
      const tokens: number[] = [];
      for (const { runId } of runs) {
        const events = await server.getEvents(runId);
        const lockEvents = events.filter((e) =>
          e.eventType.startsWith('lock_')
        );
        const types = lockEvents.map((e) => e.eventType);
        // Waited or not, one lock_created at most: retries append nothing.
        expect(types.filter((t) => t === 'lock_created').length).toBeLessThan(
          2
        );
        expect(types.filter((t) => t === 'lock_acquired')).toHaveLength(1);
        expect(types.filter((t) => t === 'lock_released')).toHaveLength(1);
        const acquired = lockEvents.find(
          (e) => e.eventType === 'lock_acquired'
        );
        tokens.push(Number(acquired?.lock?.fencingToken));
        // The step runs strictly inside the hold (started after the grant,
        // completed before the release), so its window bounds the holder's
        // from inside, using the World's own timestamps.
        const started = events.find((e) => e.eventType === 'step_started');
        const completed = events.find((e) => e.eventType === 'step_completed');
        windows.push({
          start: Date.parse(started?.createdAt ?? ''),
          end: Date.parse(completed?.createdAt ?? ''),
        });
      }
      expect(new Set(tokens).size).toBe(runs.length);

      // At no instant do more than `concurrency` critical sections overlap.
      const edges = windows
        .flatMap((w) => [
          { at: w.start, delta: 1 },
          { at: w.end, delta: -1 },
        ])
        .sort((a, b) => a.at - b.at || a.delta - b.delta);
      let open = 0;
      let maxOpen = 0;
      for (const edge of edges) {
        open += edge.delta;
        maxOpen = Math.max(maxOpen, open);
      }
      expect(maxOpen).toBeLessThanOrEqual(concurrency);
    }
  );
}
