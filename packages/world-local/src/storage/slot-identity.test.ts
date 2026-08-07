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
