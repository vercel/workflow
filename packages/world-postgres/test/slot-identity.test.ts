import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { SlotConflictError } from '@workflow/errors';
import {
  FIRST_SLOT,
  maxSlotOf,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SLOT_IDENTITY,
  slotEventId,
  slotFromId,
} from '@workflow/world';
import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createEventsStorage } from '../src/storage.js';

describe('Slot identity (Postgres integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let events: ReturnType<typeof createEventsStorage>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    // Contention is the point of these tests, so the pool has to be able to
    // hold every writer of a burst at once.
    pool = new Pool({ connectionString: dbUrl, max: 20 });
    events = createEventsStorage(createClient(pool));
  }, 120_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE workflow.workflow_events, workflow.workflow_steps, workflow.workflow_hooks, workflow.workflow_runs RESTART IDENTITY CASCADE'
    );
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  /** Start a run whose events are numbered by slot, and return its id. */
  async function newSlotRun(): Promise<string> {
    const result = await events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_SLOT_IDENTITY,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'test-workflow',
        input: new Uint8Array(),
      },
    });
    if (!result.run) {
      throw new Error('Expected run to be created');
    }
    return result.run.runId;
  }

  function eventsOf(runId: string) {
    // The page size is explicit: the default would silently truncate a fan-out
    // and make a dense log look sparse.
    return events.list({ runId, pagination: { limit: 500 } });
  }

  /** The slots of the run's log, in list order. */
  async function slotsOf(runId: string): Promise<number[]> {
    const { data } = await eventsOf(runId);
    return data.map((event) => slotFromId(event.eventId) ?? -1);
  }

  function ascending(slots: number[]): number[] {
    return [...slots].sort((a, b) => a - b);
  }

  function denseFrom(count: number): number[] {
    return Array.from({ length: count }, (_, index) => FIRST_SLOT + index);
  }

  async function createStep(
    runId: string,
    stepId: string,
    eventId?: string
  ): Promise<string> {
    const result = await events.create(
      runId,
      {
        eventType: 'step_created',
        specVersion: SPEC_VERSION_SLOT_IDENTITY,
        correlationId: stepId,
        eventData: { stepName: 'a-step', input: new Uint8Array() },
      },
      eventId === undefined ? undefined : { eventId }
    );
    if (!result.event) {
      throw new Error('Expected an event');
    }
    return result.event.eventId;
  }

  describe('numbering', () => {
    test('puts run_created in the first slot', async () => {
      const runId = await newSlotRun();
      await expect(slotsOf(runId)).resolves.toEqual([FIRST_SLOT]);
    });

    test('allocates dense slots for writers that hold no log', async () => {
      // A step completion reporting in, a cancellation from an API call: the
      // caller has no event log, so the world numbers the event for it.
      const runId = await newSlotRun();
      await createStep(runId, 'step_a');
      await createStep(runId, 'step_b');
      await expect(slotsOf(runId)).resolves.toEqual(denseFrom(3));
    });

    test('honours a slot the caller claims', async () => {
      const runId = await newSlotRun();
      const eventId = await createStep(runId, 'step_a', slotEventId(2));
      expect(eventId).toBe(slotEventId(2));
      await expect(slotsOf(runId)).resolves.toEqual(denseFrom(2));
    });

    test('numbers a ULID-mode run the way it always did', async () => {
      const created = await events.create(null, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: 'dpl_test',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        },
      });
      const runId = created.run?.runId as string;
      const eventId = await createStep(runId, 'step_a');
      expect(eventId).toMatch(/^wevt_/);
      expect(slotFromId(eventId)).toBeUndefined();
    });

    test('gives a lazy step start two consecutive slots', async () => {
      // One request, two events: the step_started the caller sent and the
      // step_created it deferred. Which sorts first does not matter — only
      // step_created flips the client's hasCreatedEvent — but both have to
      // land, and neither may leave a hole.
      const runId = await newSlotRun();
      const started = await events.create(runId, {
        eventType: 'step_started',
        specVersion: SPEC_VERSION_SLOT_IDENTITY,
        correlationId: 'step_a',
        eventData: { stepName: 'a-step', input: new Uint8Array() },
      });
      expect(slotFromId(started.event?.eventId ?? '')).toBe(2);
      const { data } = await eventsOf(runId);
      expect(
        data.map((event) => `${slotFromId(event.eventId)} ${event.eventType}`)
      ).toEqual(['1 run_created', '2 step_started', '3 step_created']);
    });

    test('numbers the deferred step_created below a claimed slot', async () => {
      // A claim names the top of the pair: the caller reserved both positions
      // before either landed, which is what keeps the second event off the slot
      // the next write of the same batch claimed.
      const runId = await newSlotRun();
      const started = await events.create(
        runId,
        {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_SLOT_IDENTITY,
          correlationId: 'step_a',
          eventData: { stepName: 'a-step', input: new Uint8Array() },
        },
        { eventId: slotEventId(3) }
      );
      expect(started.event?.eventId).toBe(slotEventId(3));
      const { data } = await eventsOf(runId);
      expect(
        data.map((event) => `${slotFromId(event.eventId)} ${event.eventType}`)
      ).toEqual(['1 run_created', '2 step_created', '3 step_started']);
    });

    test('keeps every claim in a burst of lazy starts', async () => {
      // The suspension flush issues its lazy starts at once, each having
      // reserved two positions. A second event numbered off the log as this
      // world sees it would take the slot the next start in the batch claimed,
      // costing every start after the first its claim.
      const runId = await newSlotRun();
      const claims = Array.from({ length: 10 }, (_, index) =>
        slotEventId(FIRST_SLOT + 2 * (index + 1))
      );
      const started = await Promise.all(
        claims.map((eventId, index) =>
          events.create(
            runId,
            {
              eventType: 'step_started',
              specVersion: SPEC_VERSION_SLOT_IDENTITY,
              correlationId: `step_${index}`,
              eventData: { stepName: 'a-step', input: new Uint8Array() },
            },
            { eventId }
          )
        )
      );
      expect(started.map((result) => result.event?.eventId)).toEqual(claims);
      expect(ascending(await slotsOf(runId))).toEqual(
        denseFrom(2 * claims.length + 1)
      );
    });

    test('rejects a claim that leaves no room for the second event', async () => {
      // The run's own run_created holds the first slot, so a claim of the second
      // means the caller reserved one position for a write that publishes two.
      const runId = await newSlotRun();
      await expect(
        events.create(
          runId,
          {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_SLOT_IDENTITY,
            correlationId: 'step_a',
            eventData: { stepName: 'a-step', input: new Uint8Array() },
          },
          { eventId: slotEventId(FIRST_SLOT + 1) }
        )
      ).rejects.toThrow(/leaves no slot below it/);
    });

    test('numbers events of runs it never created', async () => {
      // `step_completed` and `step_retrying` deliberately skip the run read, so
      // the mode comes from the log rather than from a run row in hand.
      const runId = await newSlotRun();
      await createStep(runId, 'step_a');
      const completed = await events.create(runId, {
        eventType: 'step_completed',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: 'step_a',
        eventData: { output: new Uint8Array() },
      });
      expect(slotFromId(completed.event?.eventId ?? '')).toBe(3);
    });
  });

  describe('contention', () => {
    // The primary key is the authority, and a writer that loses a position is
    // retried at one that is still free rather than abandoning the one it lost,
    // so a burst of concurrent writers still numbers itself densely.
    for (const writers of [2, 8, 50]) {
      test(`keeps ${writers} concurrent writers dense`, async () => {
        const runId = await newSlotRun();
        const ids = await Promise.all(
          Array.from({ length: writers }, (_, index) =>
            createStep(runId, `step_${index}`)
          )
        );
        expect(new Set(ids).size).toBe(writers);
        expect(ascending(await slotsOf(runId))).toEqual(denseFrom(writers + 1));
      }, 60_000);
    }

    test('numbers a burst so the highest slot is the event count', async () => {
      const runId = await newSlotRun();
      await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          createStep(runId, `step_${index}`)
        )
      );
      const { data } = await eventsOf(runId);
      expect(maxSlotOf(data)).toBe(data.length);
    });

    test('leaves no hole behind a rejected write', async () => {
      // The rejected op's slot sits below its concurrent sibling's, and a hole
      // below a published event can never be filled.
      const runId = await newSlotRun();
      const [rejected, accepted] = await Promise.allSettled([
        events.create(runId, {
          eventType: 'step_completed',
          specVersion: SPEC_VERSION_SLOT_IDENTITY,
          correlationId: 'step_never_created',
          eventData: { output: new Uint8Array() },
        }),
        createStep(runId, 'step_a'),
      ]);
      expect(rejected.status).toBe('rejected');
      expect(accepted.status).toBe('fulfilled');
      await createStep(runId, 'step_b');
      expect(ascending(await slotsOf(runId))).toEqual(denseFrom(3));
    });
  });

  describe('mode is pinned to the run', () => {
    test('rejects a slot id claimed on a ULID-numbered run', async () => {
      const created = await events.create(null, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: 'dpl_test',
          workflowName: 'test-workflow',
          input: new Uint8Array(),
        },
      });
      const runId = created.run?.runId as string;
      await expect(createStep(runId, 'step_a', slotEventId(2))).rejects.toThrow(
        /not numbered by slot/
      );
    });

    test('rejects a ULID id claimed on a slot-numbered run', async () => {
      const runId = await newSlotRun();
      await expect(
        createStep(runId, 'step_a', 'evnt_01K5Z0000000000000000000AA')
      ).rejects.toThrow(/not a slot id/);
    });

    test('ignores the spec version of later requests', async () => {
      // A run is in exactly one mode for life; only what was persisted decides.
      const runId = await newSlotRun();
      const result = await events.create(runId, {
        eventType: 'step_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: 'step_a',
        eventData: { stepName: 'a-step', input: new Uint8Array() },
      });
      expect(slotFromId(result.event?.eventId ?? '')).toBe(2);
    });
  });

  describe('conflict', () => {
    test('reports the events the loser is missing', async () => {
      const runId = await newSlotRun();
      // Out of band: something else takes the slot this caller was about to
      // claim, so the caller's log is provably missing an event.
      await createStep(runId, 'step_out_of_band');

      const conflict = await events
        .create(
          runId,
          {
            eventType: 'step_created',
            specVersion: SPEC_VERSION_SLOT_IDENTITY,
            correlationId: 'step_a',
            eventData: { stepName: 'a-step', input: new Uint8Array() },
          },
          { eventId: slotEventId(2), maxSlot: 1 }
        )
        .catch((error: unknown) => error);

      expect(SlotConflictError.is(conflict)).toBe(true);
      const slotConflict = conflict as SlotConflictError;
      expect(slotConflict.status).toBe(409);
      expect(slotConflict.eventId).toBe(slotEventId(2));
      expect(slotConflict.events?.map((event) => event.eventId)).toEqual([
        slotEventId(2),
      ]);
    });

    test('excludes events the loser already holds from the delta', async () => {
      const runId = await newSlotRun();
      await createStep(runId, 'step_one');
      await createStep(runId, 'step_two');

      const conflict = await events
        .create(
          runId,
          {
            eventType: 'step_created',
            specVersion: SPEC_VERSION_SLOT_IDENTITY,
            correlationId: 'step_a',
            eventData: { stepName: 'a-step', input: new Uint8Array() },
          },
          { eventId: slotEventId(2), maxSlot: 2 }
        )
        .catch((error: unknown) => error);

      // Slots 1 and 2 are at or below what the caller had; only 3 is news.
      expect(
        (conflict as SlotConflictError).events?.map((event) => event.eventId)
      ).toEqual([slotEventId(3)]);
    });

    test('lets the loser re-propose at the next free slot', async () => {
      const runId = await newSlotRun();
      await createStep(runId, 'step_out_of_band');
      await expect(createStep(runId, 'step_a', slotEventId(2))).rejects.toThrow(
        SlotConflictError
      );
      // Merging the delta moves the caller's own numbering forward by one.
      const eventId = await createStep(runId, 'step_a', slotEventId(3));
      expect(eventId).toBe(slotEventId(3));
      await expect(slotsOf(runId)).resolves.toEqual(denseFrom(3));
    });

    test('materializes nothing for a claim that is already taken', async () => {
      // The re-post is what the guard protects: a step row left behind by the
      // losing attempt would make the retry trip its own orphan and read that
      // as "a concurrent handler won the create".
      const runId = await newSlotRun();
      await createStep(runId, 'step_out_of_band');
      await expect(createStep(runId, 'step_a', slotEventId(2))).rejects.toThrow(
        SlotConflictError
      );
      const { rows } = await pool.query(
        'SELECT step_id FROM workflow.workflow_steps WHERE run_id = $1',
        [runId]
      );
      expect(rows.map((row) => row.step_id)).toEqual(['step_out_of_band']);
    });
  });
});
