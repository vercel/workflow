import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PreconditionFailedError } from '@workflow/errors';
import type { Event, Storage } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from '../storage.js';

/**
 * Commit-ordered event positions and the decision fence (filesystem world).
 *
 * The invariant under test: an event's log position (dense per-run `seq` +
 * a tail-dominant event key) is assigned at the publish point under the
 * run's cross-process append lock, so `seq` order == event-id order ==
 * `(createdAt, eventId)` order == commit order == visibility order. This is
 * what makes cursor-based readers unable to skip a late-committing event
 * (the root cause of the CORRUPTED_EVENT_LOG class), and what makes the
 * `stateEventCount` decision fence exact.
 */
describe('commit-ordered event positions (filesystem world)', () => {
  let testDir: string;
  let storage: ReturnType<typeof createStorage>;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `wf-event-ordering-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDir, { recursive: true });
    storage = createStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function createRun(events: Storage['events']): Promise<string> {
    const result = await events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'ordering-test',
        input: new Uint8Array([1]),
      },
    });
    if (!result.run) throw new Error('run not created');
    return result.run.runId;
  }

  async function listAll(
    events: Storage['events'],
    runId: string,
    limit = 7
  ): Promise<Event[]> {
    const log: Event[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await events.list({
        runId,
        pagination: { sortOrder: 'asc', limit, cursor },
      });
      log.push(...page.data);
      if (!page.hasMore) break;
      cursor = page.cursor ?? undefined;
    }
    return log;
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
    const { events } = storage;
    const runId = await createRun(events);
    await events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
    });
    await events.create(runId, {
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook-1',
      eventData: { token: `tok-${runId}` },
    });

    // 30 hook_received + 10 step_created racing in-process.
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      writes.push(
        events.create(runId, {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'hook-1',
          eventData: { payload: new Uint8Array([i]) },
        })
      );
    }
    for (let i = 0; i < 10; i++) {
      writes.push(
        events.create(runId, {
          eventType: 'step_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: `step-${i}`,
          eventData: { stepName: `step-${i}`, input: new Uint8Array([i]) },
        })
      );
    }
    await Promise.all(writes);

    const log = await listAll(events, runId);
    // run_created + run_started + hook_created + 30 + 10
    expectDenseLog(log, 43);
  });

  it('keeps positions dense across storage instances sharing a data dir', async () => {
    // Two storage instances have independent in-process lock maps, which
    // makes them behave like two OS processes from the locking standpoint —
    // arbitration happens through the on-disk append lock.
    const other = createStorage(testDir);
    const runId = await createRun(storage.events);
    await storage.events.create(runId, {
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook-x',
      eventData: { token: `tok-${runId}` },
    });

    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const instance = i % 2 === 0 ? storage : other;
      writes.push(
        instance.events.create(runId, {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'hook-x',
          eventData: { payload: new Uint8Array([i]) },
        })
      );
    }
    await Promise.all(writes);

    const log = await listAll(storage.events, runId);
    // run_created + hook_created + 20 hook_received
    expectDenseLog(log, 22);
  });

  it('never lets an event surface below an already-observed cursor', async () => {
    const { events } = storage;
    const runId = await createRun(events);
    await events.create(runId, {
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
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
        specVersion: SPEC_VERSION_CURRENT,
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

  it('orders the terminal event after every accepted append', async () => {
    const { events } = storage;
    const runId = await createRun(events);
    await events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
    });
    await events.create(runId, {
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook-t',
      eventData: { token: `tok-${runId}` },
    });
    await events.create(runId, {
      eventType: 'hook_received',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook-t',
      eventData: { payload: new Uint8Array([1]) },
    });
    await events.create(runId, {
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { output: new Uint8Array([2]) },
    });

    const log = await listAll(storage.events, runId);
    expectDenseLog(log, 5);
    expect(log[log.length - 1].eventType).toBe('run_completed');
  });

  it('adopts a pre-seq run with an unpositioned prefix', async () => {
    const { events } = storage;
    const runId = await createRun(events);
    await events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
    });

    // Simulate two events written by a pre-seq storage version: strip the
    // seq from real event files and remove the position counter, exactly
    // the on-disk state an upgrade encounters.
    await events.create(runId, {
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook-legacy',
      eventData: { token: `tok-${runId}` },
    });
    await events.create(runId, {
      eventType: 'hook_received',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook-legacy',
      eventData: { payload: new Uint8Array([7]) },
    });
    const eventFiles = await fs.readdir(path.join(testDir, 'events'));
    for (const file of eventFiles.filter((f) => f.startsWith(`${runId}-`))) {
      const filePath = path.join(testDir, 'events', file);
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (parsed.seq !== undefined && parsed.seq > 2) {
        delete parsed.seq;
        await fs.writeFile(filePath, JSON.stringify(parsed));
      }
    }
    const counterPath = path.join(
      testDir,
      '.locks',
      'runs',
      `${runId}.seq.json`
    );
    await fs.rm(counterPath, { force: true });
    // The in-memory event cache would otherwise serve the pre-strip copies.
    const fresh = createStorage(testDir);

    // The next append re-derives the tail from the log: 4 events exist, so
    // it takes seq 5, and the log keeps a (tolerated) unpositioned middle.
    await fresh.events.create(runId, {
      eventType: 'step_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'step-after',
      eventData: { stepName: 'step-after', input: new Uint8Array([1]) },
    });

    const log = await listAll(fresh.events, runId);
    expect(log).toHaveLength(5);
    expect(log[log.length - 1].seq).toBe(5);
    // The id-sorted order still matches list order.
    const ids = log.map((e) => e.eventId);
    expect([...ids].sort()).toEqual(ids);
  });

  describe('decision fence (stateEventCount)', () => {
    it('accepts a current snapshot, credits siblings, rejects stale writers', async () => {
      const { events } = storage;
      const runId = await createRun(events);
      await events.create(runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      });
      const tail = 2; // run_created + run_started

      // Up-to-date writer establishes the credit.
      await events.create(
        runId,
        {
          eventType: 'step_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'sib-1',
          eventData: { stepName: 'sib-1', input: new Uint8Array([1]) },
        },
        { stateEventCount: tail, stateCursor: 'cursor-A', writerId: 'w-A' }
      );

      // Sibling of the same snapshot: the log moved (by the sibling
      // itself), but the credit lets it through.
      await events.create(
        runId,
        {
          eventType: 'step_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'sib-2',
          eventData: { stepName: 'sib-2', input: new Uint8Array([2]) },
        },
        { stateEventCount: tail, stateCursor: 'cursor-A', writerId: 'w-A' }
      );

      // A different writer holding the same (now superseded) snapshot is
      // fenced: identical count + cursor, different writer identity.
      await expect(
        events.create(
          runId,
          {
            eventType: 'step_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: 'stale-1',
            eventData: { stepName: 'stale-1', input: new Uint8Array([3]) },
          },
          { stateEventCount: tail, stateCursor: 'cursor-A', writerId: 'w-B' }
        )
      ).rejects.toSatisfy((err: unknown) => PreconditionFailedError.is(err));
    });

    it('facts never fence a decision, and never bump the fence', async () => {
      const { events } = storage;
      const runId = await createRun(events);
      await events.create(runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      });
      await events.create(runId, {
        eventType: 'hook_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: 'hook-f',
        eventData: { token: `tok-${runId}` },
      });
      const tail = 3;

      // Facts land without a snapshot (out-of-band writes).
      for (let i = 0; i < 5; i++) {
        await events.create(runId, {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'hook-f',
          eventData: { payload: new Uint8Array([i]) },
        });
      }

      // A decision derived from the pre-facts snapshot is still accepted:
      // facts don't invalidate decisions (they replay at their position).
      await events.create(
        runId,
        {
          eventType: 'step_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'post-facts',
          eventData: { stepName: 'post-facts', input: new Uint8Array([9]) },
        },
        { stateEventCount: tail, stateCursor: 'cursor-F', writerId: 'w-F' }
      );

      const log = await listAll(events, runId);
      expectDenseLog(log, 9);
    });

    it('rejects a snapshot behind a foreign decision', async () => {
      const { events } = storage;
      const runId = await createRun(events);
      await events.create(runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      });

      // Writer A commits a decision at snapshot 2.
      await events.create(
        runId,
        {
          eventType: 'step_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'a-1',
          eventData: { stepName: 'a-1', input: new Uint8Array([1]) },
        },
        { stateEventCount: 2, stateCursor: 'cursor-A2', writerId: 'w-A' }
      );

      // Writer B derived its decision before A's landed (snapshot 2, its
      // own identity) — fenced.
      await expect(
        events.create(
          runId,
          {
            eventType: 'step_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: 'b-1',
            eventData: { stepName: 'b-1', input: new Uint8Array([2]) },
          },
          { stateEventCount: 2, stateCursor: 'cursor-B2', writerId: 'w-B' }
        )
      ).rejects.toSatisfy((err: unknown) => PreconditionFailedError.is(err));

      // After reloading (snapshot 3 covers A's decision), B passes.
      await events.create(
        runId,
        {
          eventType: 'step_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'b-2',
          eventData: { stepName: 'b-2', input: new Uint8Array([3]) },
        },
        { stateEventCount: 3, stateCursor: 'cursor-B3', writerId: 'w-B' }
      );

      // run_created + run_started + a-1 + b-2 (b-1 was fenced).
      const log = await listAll(events, runId);
      expectDenseLog(log, 4);
    });
  });
});
