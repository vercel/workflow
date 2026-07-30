import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { PreconditionFailedError } from '@workflow/errors';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import {
  createEventsStorage,
  createHooksStorage,
  createStepsStorage,
} from '../src/storage.js';

/**
 * Commit-ordered event positions and the currency fence.
 *
 * The invariant under test: an event's log position (dense per-run `seq` +
 * its event id) is assigned at the commit point under a per-run append
 * serializer, so `seq` order == event-id order == commit order == visibility
 * order. This is what makes cursor-based readers unable to skip a
 * late-committing event (the root cause of the CORRUPTED_EVENT_LOG class),
 * and what makes the `stateEventCount` currency fence exact: a create whose
 * snapshot the log has moved past is rejected with 412 inside the same
 * transaction as its entity mutation.
 */
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  describe('commit-ordered event positions (Postgres integration)', () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: Pool;
    let events: ReturnType<typeof createEventsStorage>;
    let hooks: ReturnType<typeof createHooksStorage>;
    let steps: ReturnType<typeof createStepsStorage>;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      const dbUrl = container.getConnectionUri();
      execSync('pnpm db:push', {
        cwd: __dirname + '/..',
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: 'inherit',
      });
      // More than one connection so creates genuinely run concurrently.
      pool = new Pool({ connectionString: dbUrl, max: 10 });
      const drizzle = createClient(pool);
      events = createEventsStorage(drizzle);
      hooks = createHooksStorage(drizzle);
      steps = createStepsStorage(drizzle);
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
      await container?.stop();
    });

    async function createRun(): Promise<string> {
      const result = await events.create(null, {
        eventType: 'run_created',
        eventData: {
          deploymentId: 'dpl_test',
          workflowName: 'ordering-test',
          input: new Uint8Array([1]),
        },
      });
      if (!result.run) throw new Error('run not created');
      return result.run.runId;
    }

    function expectDenseLog(
      log: { eventId: string; seq?: number }[],
      expectedLength?: number
    ) {
      if (expectedLength !== undefined) {
        expect(log).toHaveLength(expectedLength);
      }
      // seq is dense from 1, in listed order.
      expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
      // Listed (canonical) order is event-id order, and id order == seq order.
      const ids = log.map((e) => e.eventId);
      expect([...ids].sort()).toEqual(ids);
    }

    it('assigns dense, id-ordered positions under concurrent appends', async () => {
      const runId = await createRun();
      await events.create(runId, { eventType: 'run_started' });
      await events.create(runId, {
        eventType: 'hook_created',
        correlationId: 'hook-1',
        eventData: { token: `tok-${runId}` },
      });

      // 30 hook_received + 10 step_created racing across 10 connections.
      const writes: Promise<unknown>[] = [];
      for (let i = 0; i < 30; i++) {
        writes.push(
          events.create(runId, {
            eventType: 'hook_received',
            correlationId: 'hook-1',
            eventData: { payload: new Uint8Array([i]) },
          })
        );
      }
      for (let i = 0; i < 10; i++) {
        writes.push(
          events.create(runId, {
            eventType: 'step_created',
            correlationId: `step-${i}`,
            eventData: { stepName: `step-${i}`, input: new Uint8Array([i]) },
          })
        );
      }
      await Promise.all(writes);

      const log: { eventId: string; seq?: number }[] = [];
      let cursor: string | undefined;
      // Paginate with a small page size to exercise the cursor path.
      for (;;) {
        const page = await events.list({
          runId,
          pagination: { sortOrder: 'asc', limit: 7, cursor },
        });
        log.push(...page.data);
        if (!page.hasMore) break;
        cursor = page.cursor ?? undefined;
      }
      // run_created + run_started + hook_created + 30 + 10
      expectDenseLog(log, 43);
    });

    it('never lets an event surface below an already-observed cursor', async () => {
      const runId = await createRun();
      await events.create(runId, {
        eventType: 'hook_created',
        correlationId: 'hook-c',
        eventData: { token: `tok-${runId}` },
      });

      // Interleave: read to the tail, then append, then read from the saved
      // cursor. Every append must be visible strictly after the cursor.
      let cursor: string | undefined;
      let seen = 0;
      for (let round = 0; round < 20; round++) {
        await events.create(runId, {
          eventType: 'hook_received',
          correlationId: 'hook-c',
          eventData: { payload: new Uint8Array([round]) },
        });
        const page = await events.list({
          runId,
          pagination: { sortOrder: 'asc', cursor },
        });
        seen += page.data.length;
        cursor = page.cursor ?? cursor;
      }
      // run_created + hook_created + 20 hook_received, none skipped.
      expect(seen).toBe(22);
    });

    describe('currency fence (stateEventCount)', () => {
      it('accepts a current snapshot, credits siblings, rejects stale writers', async () => {
        const runId = await createRun();
        await events.create(runId, { eventType: 'run_started' });
        const tail = 2; // run_created + run_started

        // Up-to-date writer establishes the credit.
        await events.create(
          runId,
          {
            eventType: 'step_created',
            correlationId: 'sib-1',
            eventData: { stepName: 'sib-1', input: new Uint8Array([1]) },
          },
          { stateEventCount: tail, stateCursor: 'cursor-A' }
        );

        // Sibling of the same snapshot: log moved (by the sibling itself),
        // but the credit lets it through.
        await events.create(
          runId,
          {
            eventType: 'step_created',
            correlationId: 'sib-2',
            eventData: { stepName: 'sib-2', input: new Uint8Array([2]) },
          },
          { stateEventCount: tail, stateCursor: 'cursor-A' }
        );

        // A different writer holding a superseded snapshot is fenced.
        await expect(
          events.create(
            runId,
            {
              eventType: 'step_created',
              correlationId: 'stale-1',
              eventData: { stepName: 'stale-1', input: new Uint8Array([3]) },
            },
            { stateEventCount: tail, stateCursor: 'cursor-B' }
          )
        ).rejects.toSatisfy((err: unknown) => {
          expect(PreconditionFailedError.is(err)).toBe(true);
          expect((err as PreconditionFailedError).status).toBe(412);
          return true;
        });

        // A writer that reloaded (count reflects the sibling writes) passes.
        await events.create(
          runId,
          {
            eventType: 'step_created',
            correlationId: 'fresh-1',
            eventData: { stepName: 'fresh-1', input: new Uint8Array([4]) },
          },
          { stateEventCount: tail + 2, stateCursor: 'cursor-C' }
        );

        const log = await events.list({ runId });
        expectDenseLog(log.data, 5);
      });

      it('rejects a second writer presenting the identical snapshot', async () => {
        // Two invocations that loaded the same prefix send byte-identical
        // cursor+count. The credit must be keyed on the writer identity, not
        // the snapshot: admitting both interleaves two derivations' write
        // sets (observed as alternating decision batches whose correlation
        // ordinals invert against commit order → CORRUPTED_EVENT_LOG).
        const runId = await createRun();
        await events.create(runId, { eventType: 'run_started' });
        const snapshot = { stateEventCount: 2, stateCursor: 'same-cursor' };

        // Writer A flushes two siblings.
        await events.create(
          runId,
          {
            eventType: 'step_created',
            correlationId: 'a-1',
            eventData: { stepName: 'a-1', input: new Uint8Array([1]) },
          },
          { ...snapshot, writerId: 'writer-A' }
        );
        await events.create(
          runId,
          {
            eventType: 'step_created',
            correlationId: 'a-2',
            eventData: { stepName: 'a-2', input: new Uint8Array([2]) },
          },
          { ...snapshot, writerId: 'writer-A' }
        );

        // Writer B raced the same replay from the same prefix: same snapshot,
        // different writer. It must be fenced, not credited.
        await expect(
          events.create(
            runId,
            {
              eventType: 'step_created',
              correlationId: 'b-1',
              eventData: { stepName: 'b-1', input: new Uint8Array([3]) },
            },
            { ...snapshot, writerId: 'writer-B' }
          )
        ).rejects.toSatisfy(PreconditionFailedError.is);
      });

      it('rolls the entity mutation back with the fenced event', async () => {
        const runId = await createRun();
        await events.create(runId, { eventType: 'run_started' });

        // A foreign DECISION (snapshot-carrying create) lands past the
        // snapshot the fenced create will claim.
        await events.create(
          runId,
          {
            eventType: 'hook_created',
            correlationId: 'hook-f',
            eventData: { token: `tok-${runId}` },
          },
          { stateEventCount: 2, stateCursor: 'winning-cursor' }
        );

        await expect(
          events.create(
            runId,
            {
              eventType: 'step_created',
              correlationId: 'fenced-step',
              eventData: { stepName: 'fenced', input: new Uint8Array([1]) },
            },
            { stateEventCount: 2, stateCursor: 'stale-cursor' }
          )
        ).rejects.toSatisfy(PreconditionFailedError.is);

        // The step row must NOT exist: the mutation and the event insert are
        // one transaction, so a 412 cannot leave an orphaned entity behind.
        await expect(steps.get(runId, 'fenced-step')).rejects.toThrow(
          'Step not found'
        );
        const log = await events.list({ runId });
        expectDenseLog(log.data, 3);
      });

      it('does not fence a decision on interleaved facts (buffered events)', async () => {
        const runId = await createRun();
        await events.create(runId, { eventType: 'run_started' });
        await events.create(runId, {
          eventType: 'hook_created',
          correlationId: 'hook-i',
          eventData: { token: `tok-${runId}` },
        });
        const loaded = 3;

        // Out-of-band facts land after the writer loaded its snapshot. They
        // carry no snapshot, so they are buffered events in Temporal's
        // sense: they get a log position after the snapshot and are
        // delivered there on replay, but they must not invalidate decisions
        // derived before them — fencing on them would restart the replay of
        // any run under steady inbound-hook load on every write.
        for (let i = 0; i < 3; i++) {
          await events.create(runId, {
            eventType: 'hook_received',
            correlationId: 'hook-i',
            eventData: { payload: new Uint8Array([i]) },
          });
        }

        // The writer's decision still lands, positioned after the facts.
        const result = await events.create(
          runId,
          {
            eventType: 'step_created',
            correlationId: 'post-hook-step',
            eventData: { stepName: 'x', input: new Uint8Array([1]) },
          },
          { stateEventCount: loaded, stateCursor: 'cursor-Z' }
        );
        expect(result.event?.seq).toBe(7);

        // But a foreign decision made from the same stale snapshot is
        // fenced: the step_created above bumped the decision watermark.
        await expect(
          events.create(
            runId,
            {
              eventType: 'step_created',
              correlationId: 'foreign-step',
              eventData: { stepName: 'y', input: new Uint8Array([2]) },
            },
            { stateEventCount: loaded, stateCursor: 'cursor-other' }
          )
        ).rejects.toSatisfy(PreconditionFailedError.is);
      });
    });

    it('gives a lazy step_started consecutive positions for both events', async () => {
      const runId = await createRun();
      await events.create(runId, { eventType: 'run_started' });

      const result = await events.create(runId, {
        eventType: 'step_started',
        correlationId: 'lazy-step',
        eventData: { stepName: 'lazy', input: new Uint8Array([1]) },
      });
      expect(result.stepCreated).toBe(true);

      const log = await events.list({ runId });
      expectDenseLog(log.data, 4);
      const created = log.data.find((e) => e.eventType === 'step_created');
      const started = log.data.find((e) => e.eventType === 'step_started');
      expect(created?.seq).toBe(3);
      expect(started?.seq).toBe(4);
      expect(started!.eventId > created!.eventId).toBe(true);
    });

    it('initializes counters from a pre-migration log and stays dense', async () => {
      const runId = await createRun();
      await events.create(runId, { eventType: 'run_started' });
      await events.create(runId, {
        eventType: 'hook_created',
        correlationId: 'hook-m',
        eventData: { token: `tok-${runId}` },
      });

      // Simulate a run written before the migration: null seqs, zeroed
      // counters.
      await pool.query(
        `UPDATE workflow.workflow_events SET seq = NULL WHERE run_id = $1`,
        [runId]
      );
      await pool.query(
        `UPDATE workflow.workflow_runs SET next_event_seq = 0, last_event_id = NULL WHERE id = $1`,
        [runId]
      );

      const result = await events.create(runId, {
        eventType: 'hook_received',
        correlationId: 'hook-m',
        eventData: { payload: new Uint8Array([1]) },
      });

      // The new event continues after the unpositioned prefix: seq = 4, and
      // its id still sorts after every pre-existing event.
      expect(result.event?.seq).toBe(4);
      const log = await events.list({ runId });
      expect(log.data.map((e) => e.seq)).toEqual([
        undefined,
        undefined,
        undefined,
        4,
      ]);
      const ids = log.data.map((e) => e.eventId);
      expect([...ids].sort()).toEqual(ids);
    });

    it('keeps hooks usable: fence params on hook lifecycle events', async () => {
      const runId = await createRun();
      await events.create(runId, { eventType: 'run_started' });

      // hook_created carrying a current snapshot passes and creates the hook.
      const created = await events.create(
        runId,
        {
          eventType: 'hook_created',
          correlationId: 'hook-l',
          eventData: { token: `tok-${runId}` },
        },
        { stateEventCount: 2, stateCursor: 'cursor-H' }
      );
      expect(created.hook).toBeDefined();
      const hook = await hooks.getByToken(`tok-${runId}`);
      expect(hook.hookId).toBe('hook-l');
    });
  });
}
