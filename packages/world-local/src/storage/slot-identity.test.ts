import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EVENT_ID_BODY_LENGTH,
  EVENT_ID_PREFIX,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from '../storage.js';
import { monotonicUlid } from './helpers.js';

let testDir: string;
let storage: ReturnType<typeof createStorage>;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-slot-'));
  storage = createStorage(testDir);
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const serialized = (value: unknown) =>
  ({ data: JSON.stringify(value), encoding: 'json' }) as any;

function slotId(slot: number): string {
  return `${EVENT_ID_PREFIX}${String(slot).padStart(EVENT_ID_BODY_LENGTH, '0')}`;
}

async function startRun(): Promise<string> {
  const created = await storage.events.create('', {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'dpl_slot',
      workflowName: 'slotWorkflow',
      input: serialized([]),
    },
  } as any);
  const { runId } = created.event;
  await storage.events.create(runId, {
    eventType: 'run_started',
    specVersion: SPEC_VERSION_CURRENT,
  } as any);
  return runId;
}

async function listEventIds(runId: string): Promise<string[]> {
  const result = await storage.events.list({
    runId,
    pagination: { limit: 1000 },
  });
  return result.data.map((event) => event.eventId);
}

function slotsOf(eventIds: string[]): (number | null)[] {
  return eventIds.map((eventId) => eventIdToSlot(eventId));
}

describe('slot event ids', () => {
  it('numbers a new run densely from the first slot, in log order', async () => {
    const runId = await startRun();
    for (let i = 0; i < 5; i++) {
      await storage.events.create(runId, {
        eventType: 'step_created',
        correlationId: `step_${i}`,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { stepName: `step${i}`, input: serialized([]) },
      } as any);
    }

    const eventIds = await listEventIds(runId);
    // run_created, run_started, then one step_created each. `events.list`
    // returns chronological order, so the slots must come out sorted and
    // gapless starting at the first slot.
    expect(eventIds).toEqual(
      eventIds.map((_, i) => slotId(FIRST_EVENT_SLOT + i))
    );
  });

  it('stays dense when writers race for the same slot', async () => {
    const runId = await startRun();
    const width = 20;
    await Promise.all(
      Array.from({ length: width }, (_, i) =>
        storage.events.create(runId, {
          eventType: 'step_created',
          correlationId: `step_${i}`,
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { stepName: `step${i}`, input: serialized([]) },
        } as any)
      )
    );

    // Every writer starts from the same view of the log, so all but one lose
    // the publish and bump. Bump-and-report means none of them fail, and the
    // log they produce is still gapless.
    const slots = slotsOf(await listEventIds(runId));
    expect(slots).toEqual(
      Array.from({ length: width + 2 }, (_, i) => FIRST_EVENT_SLOT + i)
    );
  });

  it('orders a terminal event after every event it raced', async () => {
    const runId = await startRun();
    await storage.events.create(runId, {
      eventType: 'step_created',
      correlationId: 'step_a',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { stepName: 'a', input: serialized([]) },
    } as any);
    await storage.events.create(runId, {
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { output: serialized('done') },
    } as any);

    const eventIds = await listEventIds(runId);
    expect(eventIds.at(-1)).toBe(slotId(eventIds.length));
  });

  it('keeps a ULID-numbered run on ULIDs', async () => {
    const runId = await startRun();
    // Rewrite the run's log the way it would look had it been created before
    // slot ids existed. The scheme is pinned by what is on disk, not by a
    // stored flag, so this is the whole of the upgrade path.
    const eventsDir = path.join(testDir, 'events');
    const files = (await fs.readdir(eventsDir)).filter((file) =>
      file.startsWith(`${runId}-`)
    );
    files.sort();
    for (const file of files) {
      const legacyId = `${EVENT_ID_PREFIX}${monotonicUlid()}`;
      const raw = await fs.readFile(path.join(eventsDir, file), 'utf8');
      await fs.writeFile(
        path.join(eventsDir, `${runId}-${legacyId}.json`),
        raw.replace(/"eventId": "evnt_[^"]+"/, `"eventId": "${legacyId}"`)
      );
      await fs.rm(path.join(eventsDir, file));
    }
    // The allocator memoizes each run's scheme, so drop the cache the way a
    // fresh process would see it.
    storage.events.clearCache?.();

    await storage.events.create(runId, {
      eventType: 'step_created',
      correlationId: 'step_after_upgrade',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { stepName: 'afterUpgrade', input: serialized([]) },
    } as any);

    const eventIds = await listEventIds(runId);
    expect(eventIds).toHaveLength(3);
    // No slot ids anywhere: one slot id in a ULID log would sort before every
    // ULID (its body starts with ten zeros) and replay out of order.
    expect(slotsOf(eventIds)).toEqual([null, null, null]);
  });
});

describe('skipped-slot report', () => {
  /** Writes `count` step_created events, returning the slots they landed on. */
  async function fill(runId: string, count: number): Promise<number[]> {
    const slots: number[] = [];
    for (let i = 0; i < count; i++) {
      const result = await storage.events.create(runId, {
        eventType: 'step_created',
        correlationId: `filler_${i}`,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { stepName: `filler${i}`, input: serialized([]) },
      } as any);
      slots.push(eventIdToSlot(result.event.eventId) as number);
    }
    return slots;
  }

  it('hands back the events occupying the slots the write skipped', async () => {
    const runId = await startRun();
    const stale = FIRST_EVENT_SLOT + 1; // what the run had after run_started
    const filled = await fill(runId, 3);

    // A writer whose loaded log stopped at run_started asks for the slot right
    // above it and is bumped past everything written since.
    const result = await storage.events.create(
      runId,
      {
        eventType: 'wait_created',
        correlationId: 'wait_a',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { waitUntil: new Date(0).toISOString() },
      } as any,
      { eventCount: stale }
    );

    expect(eventIdToSlot(result.event.eventId)).toBe(stale + filled.length + 1);
    expect(result.events?.map((event) => event.eventId)).toEqual(
      filled.map(slotId)
    );
    expect(result.hasMore).toBe(false);
  });

  it('reports nothing when the write lands on the slot it asked for', async () => {
    const runId = await startRun();
    const result = await storage.events.create(
      runId,
      {
        eventType: 'wait_created',
        correlationId: 'wait_a',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { waitUntil: new Date(0).toISOString() },
      } as any,
      { eventCount: FIRST_EVENT_SLOT + 1 }
    );

    expect(eventIdToSlot(result.event.eventId)).toBe(FIRST_EVENT_SLOT + 2);
    expect(result.events).toBeUndefined();
  });

  it('reports nothing when the writer sends no count', async () => {
    const runId = await startRun();
    await fill(runId, 2);
    const result = await storage.events.create(runId, {
      eventType: 'wait_created',
      correlationId: 'wait_a',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { waitUntil: new Date(0).toISOString() },
    } as any);

    expect(result.events).toBeUndefined();
  });

  it('gives every racing writer the events it was decided without', async () => {
    const runId = await startRun();
    const stale = FIRST_EVENT_SLOT + 1;
    const width = 8;

    // All eight start from the same view, so seven of them are bumped and each
    // one's report covers exactly the slots between `stale` and where it
    // landed. Under contention the report can be a lower bound: a writer
    // holding a lower slot may not have published yet, which `hasMore` says.
    const results = await Promise.all(
      Array.from({ length: width }, (_, i) =>
        storage.events.create(
          runId,
          {
            eventType: 'step_created',
            correlationId: `racer_${i}`,
            specVersion: SPEC_VERSION_CURRENT,
            eventData: { stepName: `racer${i}`, input: serialized([]) },
          } as any,
          { eventCount: stale }
        )
      )
    );

    for (const result of results) {
      const landed = eventIdToSlot(result.event.eventId) as number;
      const reported = result.events ?? [];
      const span = landed - stale - 1;
      expect(reported.length).toBeLessThanOrEqual(span);
      expect(result.hasMore ?? false).toBe(reported.length < span);
      for (const event of reported) {
        const slot = eventIdToSlot(event.eventId) as number;
        expect(slot).toBeGreaterThan(stale);
        expect(slot).toBeLessThan(landed);
      }
    }
  });
});

describe('awaited-resolution fence', () => {
  /**
   * Runs a step to completion and answers the slot the log stood at *before*
   * the completion landed: a stale writer's view of the world.
   */
  async function settledStep(
    runId: string,
    correlationId: string
  ): Promise<number> {
    await storage.events.create(runId, {
      eventType: 'step_created',
      correlationId,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { stepName: 'settle', input: serialized([]) },
    } as any);
    const started = await storage.events.create(runId, {
      eventType: 'step_started',
      correlationId,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {},
    } as any);
    const stale = eventIdToSlot(started.event.eventId) as number;
    await storage.events.create(runId, {
      eventType: 'step_completed',
      correlationId,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { result: serialized('ok') },
    } as any);
    return stale;
  }

  const branchWrite = (correlationId: string) =>
    ({
      eventType: 'step_created',
      correlationId,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { stepName: 'recover', input: serialized([]) },
    }) as any;

  it('refuses a write whose branch was decided without a resolution it awaits', async () => {
    const runId = await startRun();
    const stale = await settledStep(runId, 'step_settle');
    const before = await listEventIds(runId);

    // This is the corrupting shape: the writer raced `step_settle` against a
    // watchdog, never saw it complete, and is committing the recovery branch.
    await expect(
      storage.events.create(runId, branchWrite('step_recover'), {
        eventCount: stale,
        awaitingCorrelationIds: ['step_settle'],
      })
    ).rejects.toMatchObject({ status: 412 });

    // Refused before the insert. A rejection after the fact would be useless:
    // the divergent event would already be in the log.
    expect(await listEventIds(runId)).toEqual(before);
  });

  it('attaches the events the writer had not seen to the rejection', async () => {
    const runId = await startRun();
    const stale = await settledStep(runId, 'step_settle');

    const rejection = await storage.events
      .create(runId, branchWrite('step_recover'), {
        eventCount: stale,
        awaitingCorrelationIds: ['step_settle'],
      })
      .catch((error: any) => error);

    // The whole unseen tail, not just the offending event: a replay that
    // resumed knowing only about the resolution would be stale again at once.
    expect(rejection.details.events.map((e: any) => e.eventId)).toEqual(
      (await listEventIds(runId)).slice(stale)
    );
  });

  it('lets a resolution nobody awaits through, and reports it instead', async () => {
    const runId = await startRun();
    const stale = await settledStep(runId, 'step_settle');

    // The user's case: an out-of-band delivery landing ahead of a replay's own
    // write is a valid log. It commits, and the writer is told what it missed.
    const result = await storage.events.create(
      runId,
      branchWrite('step_other'),
      { eventCount: stale, awaitingCorrelationIds: ['step_unrelated'] }
    );

    expect(eventIdToSlot(result.event.eventId)).toBe(stale + 2);
    expect(result.events?.map((event) => event.eventId)).toEqual([
      slotId(stale + 1),
    ]);
  });

  it('does not fence on a skipped event that settles nothing', async () => {
    const runId = await startRun();
    const stale = FIRST_EVENT_SLOT + 1;
    await storage.events.create(runId, branchWrite('step_sibling'));

    // A sibling's `step_created` is not a resolution, so it is reported rather
    // than fenced even while the writer awaits something.
    const result = await storage.events.create(
      runId,
      branchWrite('step_mine'),
      { eventCount: stale, awaitingCorrelationIds: ['step_sibling'] }
    );

    expect(result.events).toHaveLength(1);
  });

  it('fences the whole batch of one suspension, not part of it', async () => {
    const runId = await startRun();
    const stale = await settledStep(runId, 'step_settle');

    // Every write of one suspension carries the same count and the same
    // awaited set, and the events it missed sit directly above that count, so
    // each one skips over all of them. A batch that fenced only partway would
    // leave the log holding the siblings that landed.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        storage.events.create(runId, branchWrite(`step_recover_${i}`), {
          eventCount: stale,
          awaitingCorrelationIds: ['step_settle'],
        })
      )
    );

    expect(outcomes.map((o) => o.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
  });

  it('ignores the awaited set when the writer sends no count', async () => {
    const runId = await startRun();
    await settledStep(runId, 'step_settle');

    // No count means no claimed position, so there is no span of skipped slots
    // to fence on. Writers outside a replay take this path.
    await expect(
      storage.events.create(runId, branchWrite('step_recover'), {
        awaitingCorrelationIds: ['step_settle'],
      })
    ).resolves.toBeDefined();
  });
});
