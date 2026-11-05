import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  type AnyEventRequest,
  type Event,
  eventIdToSlot,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type Storage,
} from '@workflow/world';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createWorld } from '../src/index.js';
import {
  createRunEventsFeed,
  RUN_EVENTS_TOPIC,
  type RunEventsFeed,
} from '../src/run-events.js';
import { createEventsStorage } from '../src/storage.js';
import { TestPool } from './pool.js';

async function until<T>(
  read: () => T | Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for the feed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const SPEC = SPEC_VERSION_SINGLE_ORCHESTRATOR;

/**
 * `events.subscribe` on world-postgres: every committed write of a spec 9 run
 * is announced with `NOTIFY`, and a subscription delivers the run's events
 * from the table in slot order, from any writer and any process.
 */
describe.skipIf(process.platform === 'win32')(
  'Postgres run event feed (LISTEN/NOTIFY, real database)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    /** The writer: another process's events storage, sharing the database. */
    let writer: Storage['events'];
    let feed: RunEventsFeed;
    /** The subscriber's events storage. */
    let events: Storage['events'];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      pool = new TestPool({
        connectionString: container.getConnectionUri(),
        max: 20,
      });
      await migrate(drizzle(pool), {
        migrationsFolder: fileURLToPath(
          new URL('../src/drizzle/migrations', import.meta.url)
        ),
        migrationsTable: 'workflow_migrations',
        migrationsSchema: 'workflow_drizzle',
      });
      writer = createEventsStorage(createClient(pool));
      feed = createRunEventsFeed(pool, { maxLiveSubscriptions: 3 });
      events = createEventsStorage(createClient(pool), {
        runEventsFeed: feed,
      });
    }, 120_000);

    afterAll(async () => {
      await feed?.close();
      await pool?.end();
      await container?.stop();
    });

    async function createRun(specVersion = SPEC): Promise<string> {
      const runId = `wrun_${ulid()}`;
      await writer.create(runId, {
        eventType: 'run_created',
        specVersion,
        eventData: {
          deploymentId: 'dpl_feed',
          workflowName: 'feed',
          input: new Uint8Array([1]),
        },
      } as AnyEventRequest);
      return runId;
    }

    const waitCreated = (correlationId: string, specVersion = SPEC) =>
      ({
        eventType: 'wait_created',
        correlationId,
        specVersion,
        eventData: { resumeAt: new Date(Date.now() + 60_000) },
      }) as AnyEventRequest;

    function subscribe(runId: string, afterSlot: number) {
      const received: Event[] = [];
      const errors: unknown[] = [];
      const unsubscribe = events.subscribe!(
        runId,
        afterSlot,
        (event) => received.push(event),
        { onError: (error) => errors.push(error) }
      );
      return {
        received,
        errors,
        unsubscribe,
        slots: () => received.map((event) => eventIdToSlot(event.eventId)),
      };
    }

    it('offers subscribe from createWorld', () => {
      const world = createWorld({ pool });
      expect(typeof world.events.subscribe).toBe('function');
    });

    it("delivers another writer's events in slot order, from the slot after afterSlot", async () => {
      const runId = await createRun();
      await writer.create(runId, waitCreated('wait_a'));
      const sub = subscribe(runId, 1);
      // What was committed before the subscription is read on subscribe.
      await until(sub.slots, (slots) => slots.length === 1);
      await writer.create(runId, waitCreated('wait_b'));
      await writer.create(runId, waitCreated('wait_c'));
      await until(sub.slots, (slots) => slots.length === 3);
      expect(sub.slots()).toEqual([2, 3, 4]);
      expect(sub.received.map((event) => event.correlationId)).toEqual([
        'wait_a',
        'wait_b',
        'wait_c',
      ]);
      // With the data a full read returns.
      expect(sub.received[0]!.eventData).toMatchObject({
        resumeAt: expect.any(Date),
      });
      expect(sub.errors).toEqual([]);
      sub.unsubscribe();
    });

    it('delivers each slot once to each subscription under concurrent writes', async () => {
      const runId = await createRun();
      const first = subscribe(runId, 1);
      const second = subscribe(runId, 1);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          writer.create(runId, waitCreated(`wait_${i}`))
        )
      );
      const expected = Array.from({ length: 20 }, (_, i) => i + 2);
      await until(first.slots, (slots) => slots.length >= 20);
      await until(second.slots, (slots) => slots.length >= 20);
      // Settle any late announcement.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(first.slots()).toEqual(expected);
      expect(second.slots()).toEqual(expected);
      first.unsubscribe();
      second.unsubscribe();
    });

    it('delivers nothing after unsubscribe', async () => {
      const runId = await createRun();
      const sub = subscribe(runId, 1);
      await writer.create(runId, waitCreated('wait_a'));
      await until(sub.slots, (slots) => slots.length === 1);
      sub.unsubscribe();
      sub.unsubscribe();
      await writer.create(runId, waitCreated('wait_b'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sub.slots()).toEqual([2]);
      expect(sub.errors).toEqual([]);
    });

    it('does not announce a spec 8 write', async () => {
      const runId = await createRun(8);
      const sub = subscribe(runId, 1);
      // The subscription's own first read happens once LISTEN is up.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await writer.create(runId, waitCreated('wait_a', 8));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sub.received).toEqual([]);
      sub.unsubscribe();
    });

    it('refuses subscriptions past the per-process cap, through onError', async () => {
      const runId = await createRun();
      const live = [
        subscribe(runId, 1),
        subscribe(runId, 1),
        subscribe(runId, 1),
      ];
      const refused = subscribe(runId, 1);
      await until(
        () => refused.errors.length,
        (n) => n === 1
      );
      expect(String(refused.errors[0])).toMatch(/live run event feeds/);
      for (const sub of live) sub.unsubscribe();
      // A slot freed by unsubscribe takes the next subscription.
      const next = subscribe(runId, 0);
      await until(next.slots, (slots) => slots.length === 1);
      expect(next.errors).toEqual([]);
      next.unsubscribe();
    });

    it('ends every subscription through onError when the LISTEN connection drops, and serves new ones once it is back', async () => {
      const runId = await createRun();
      const sub = subscribe(runId, 1);
      await writer.create(runId, waitCreated('wait_a'));
      await until(sub.slots, (slots) => slots.length === 1);

      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE query = $1 AND pid <> pg_backend_pid()`,
        [`LISTEN ${RUN_EVENTS_TOPIC}`]
      );
      await until(
        () => sub.errors.length,
        (n) => n === 1
      );
      // Ended: a later write is not delivered to it.
      await writer.create(runId, waitCreated('wait_b'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sub.slots()).toEqual([2]);

      // The shared connection reconnects; a new subscription is served.
      const next = await until(
        async () => {
          const attempt = subscribe(runId, 2);
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (attempt.errors.length > 0) {
            attempt.unsubscribe();
            return undefined;
          }
          return attempt;
        },
        (attempt) => attempt !== undefined
      );
      await until(next!.slots, (slots) => slots.length === 1);
      expect(next!.slots()).toEqual([3]);
      next!.unsubscribe();
    });
  }
);
