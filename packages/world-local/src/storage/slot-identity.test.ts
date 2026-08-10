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
import { SORT_KEY_CURSOR_PREFIX } from '../fs.js';
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

  it('leaves no hole behind writes that are rejected', async () => {
    const runId = await startRun();
    const width = 20;
    // Every writer claims the same correlation id, so exactly one
    // step_created survives the entity-creation dedup and the rest are
    // rejected. A slot
    // drawn before the publish and never handed back would be burned by each
    // rejection, and allocation only moves forward, so every such hole is
    // permanent.
    const results = await Promise.allSettled(
      Array.from({ length: width }, () =>
        storage.events.create(runId, {
          eventType: 'step_created',
          correlationId: 'step_contended',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { stepName: 'contended', input: serialized([]) },
        } as any)
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    // The next write is what exposes a burned slot: it lands right behind the
    // winner if every rejection gave its slot back, and `width - 1` positions
    // past it if none of them did.
    await storage.events.create(runId, {
      eventType: 'step_created',
      correlationId: 'step_after',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { stepName: 'after', input: serialized([]) },
    } as any);

    const slots = slotsOf(await listEventIds(runId));
    // run_created, run_started, the one step_created that won, and the write
    // that followed it.
    expect(slots).toEqual([
      FIRST_EVENT_SLOT,
      FIRST_EVENT_SLOT + 1,
      FIRST_EVENT_SLOT + 2,
      FIRST_EVENT_SLOT + 3,
    ]);
  });

  it('leaves no hole when a rejected write is overtaken by another', async () => {
    const runId = await startRun();
    const width = 8;
    for (let i = 0; i < width; i++) {
      await storage.events.create(runId, {
        eventType: 'step_started',
        correlationId: `step_${i}`,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { stepName: `step${i}`, input: serialized([]) },
      } as any);
    }

    // Each duplicate names a different step, so they take different per-step
    // locks and their draws interleave. This is the shape a step storm
    // produces: several replays of one run each re-issuing a step_started the
    // winner already published. A slot reserved at the draw and handed back
    // only when it is still the highest one drawn cannot survive this — by the
    // time a rejection lands, the next writer has drawn past it.
    const results = await Promise.allSettled(
      Array.from({ length: width }, (_, i) =>
        storage.events.create(runId, {
          eventType: 'step_started',
          correlationId: `step_${i}`,
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { stepName: `step${i}`, input: serialized([]) },
        } as any)
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(0);

    await storage.events.create(runId, {
      eventType: 'step_created',
      correlationId: 'step_after',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { stepName: 'after', input: serialized([]) },
    } as any);

    // run_created, run_started, a step_created + step_started per step, and
    // the write that followed the rejections.
    const slots = slotsOf(await listEventIds(runId));
    expect(slots).toEqual(
      Array.from({ length: width * 2 + 3 }, (_, i) => FIRST_EVENT_SLOT + i)
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

  it('numbers a lazily created step_created from the same allocator', async () => {
    const runId = await startRun();
    // A step_started carrying the creation payload with no step_created ahead
    // of it makes the World synthesize one. That synthetic event is the only
    // event the World writes without a caller asking for it by name, so it is
    // the one place a second id scheme can leak into a slot-numbered log.
    await storage.events.create(runId, {
      eventType: 'step_started',
      correlationId: 'step_lazy',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { stepName: 'lazy', input: serialized([]) },
    } as any);

    const eventIds = await listEventIds(runId);
    expect(slotsOf(eventIds)).toEqual(
      Array.from({ length: eventIds.length }, (_, i) => FIRST_EVENT_SLOT + i)
    );
    // A ULID id here has no sort key, so `events.list` would return it on
    // every page and the cursor would eventually repeat.
    const events = await storage.events.list({
      runId,
      pagination: { limit: 1000 },
    });
    // The synthetic step_created takes the lower slot: the step_started that
    // triggered it holds a candidate, not a reservation, so publishing the
    // step_created first pushes the step_started up one. Replay reads them in
    // the order they happened.
    expect(events.data.map((event) => event.eventType)).toEqual([
      'run_created',
      'run_started',
      'step_created',
      'step_started',
    ]);
  });

  it('paginates a run whose step_created events were created lazily', async () => {
    const runId = await startRun();
    for (let i = 0; i < 6; i++) {
      await storage.events.create(runId, {
        eventType: 'step_started',
        correlationId: `step_lazy_${i}`,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { stepName: `lazy${i}`, input: serialized([]) },
      } as any);
    }

    // Walk the log the way the runtime does: one page at a time, asserting the
    // cursor always advances. A mixed-scheme log stalls here rather than at
    // the id assertion above.
    const seenCursors = new Set<string>();
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await storage.events.list({
        runId,
        pagination: { limit: 3, sortOrder: 'asc', cursor },
      });
      walked.push(...result.data.map((event) => event.eventId));
      if (!result.hasMore) break;
      expect(result.cursor).toBeTruthy();
      expect(seenCursors.has(result.cursor as string)).toBe(false);
      seenCursors.add(result.cursor as string);
      cursor = result.cursor as string;
    }

    expect(walked).toEqual(await listEventIds(runId));
    expect(slotsOf(walked)).toEqual(
      Array.from({ length: walked.length }, (_, i) => FIRST_EVENT_SLOT + i)
    );
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
        eventData: { resumeAt: new Date(0).toISOString() },
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
        eventData: { resumeAt: new Date(0).toISOString() },
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
      eventData: { resumeAt: new Date(0).toISOString() },
    } as any);

    expect(result.events).toBeUndefined();
  });

  it('lets the sinceCursor delta answer when the writer asks for both', async () => {
    // `sinceCursor` and `eventCount` both report through
    // `events`/`cursor`/`hasMore`, and the runtime sends both on the same
    // write. The delta is a strict superset of the skipped span (the skipped
    // slots are all above the cursor) and, unlike the report, it advances
    // `cursor`. Returning the narrower set alongside the delta's cursor would
    // tell the caller it has read up to the delta end while handing it only
    // part of that range, and the events in between would never be fetched
    // again.
    const runId = await startRun();
    const stale = FIRST_EVENT_SLOT + 1;
    const filled = await fill(runId, 3);

    const result = await storage.events.create(
      runId,
      {
        eventType: 'wait_created',
        correlationId: 'wait_a',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { resumeAt: new Date(0).toISOString() },
      } as any,
      {
        eventCount: stale,
        sinceCursor: `${SORT_KEY_CURSOR_PREFIX}${slotId(stale)}`,
      }
    );

    const committed = result.event.eventId;
    expect(eventIdToSlot(committed)).toBe(stale + filled.length + 1);
    // Everything after the cursor, this write's own event included.
    expect(result.events?.map((event) => event.eventId)).toEqual([
      ...filled.map(slotId),
      committed,
    ]);
    expect(result.cursor).toBe(`${SORT_KEY_CURSOR_PREFIX}${committed}`);
    expect(result.hasMore).toBe(false);
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
