/**
 * The in-band writer fence: an in-band write is
 * accepted only when its `expectedSeqInBand` matches the run's count, a
 * refusal writes nothing, out-of-band writes leave the count alone, and of
 * concurrent in-band writers holding the same count exactly one wins. `list`
 * reports the count as `snapshot.seqInBand`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EntityConflictError, InBandSupersededError } from '@workflow/errors';
import {
  type AnyEventRequest,
  eventIdToSlot,
  IN_BAND_SEQ_AT_RUN_CREATION,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inBandFenceConformance } from '../../../world/src/test-support/in-band-fence-conformance.js';
import { createWorld } from '../index.js';
import { createStorage } from '../storage.js';

const SPEC = SPEC_VERSION_CURRENT;
let testDir: string;
let storage: ReturnType<typeof createStorage>;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-fence-'));
  storage = createStorage(testDir);
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const serialized = (value: unknown) =>
  ({ data: JSON.stringify(value), encoding: 'json' }) as never;

async function createRun(): Promise<string> {
  const created = await storage.events.create('', {
    eventType: 'run_created',
    specVersion: SPEC,
    eventData: {
      deploymentId: 'dpl_fence',
      workflowName: 'fenceWorkflow',
      input: serialized([]),
    },
  } as AnyEventRequest);
  return created.event?.runId as string;
}

async function snapshotOf(runId: string) {
  const page = await storage.events.list({ runId });
  return { snapshot: page.snapshot, slots: page.data.map(slotOf) };
}

function slotOf(event: { eventId: string }) {
  return eventIdToSlot(event.eventId);
}

function attrSet(value: string): AnyEventRequest {
  return {
    eventType: 'attr_set',
    specVersion: SPEC,
    eventData: {
      changes: [{ key: 'k', value }],
      writer: { type: 'workflow' },
    },
  } as AnyEventRequest;
}

// The fence behavior every World shares, each test on a fresh data dir.
const conformanceDirs: string[] = [];
afterAll(() => {
  for (const dir of conformanceDirs)
    rmSync(dir, { recursive: true, force: true });
});
inBandFenceConformance({
  name: 'world-local',
  events: () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wl-fence-conf-'));
    conformanceDirs.push(dir);
    return createStorage(dir).events;
  },
  capabilities: () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wl-fence-caps-'));
    conformanceDirs.push(dir);
    return createWorld({ dataDir: dir }).capabilities;
  },
  // world-local mints the run id.
  newRunId: () => null,
  atRunCreation: IN_BAND_SEQ_AT_RUN_CREATION,
});

describe('in-band fence (world-local)', () => {
  it('does not advance the count when the World refuses an in-band write with a 4xx', async () => {
    const runId = await createRun();
    const stepCreated = {
      eventType: 'step_created',
      correlationId: 'step_1',
      specVersion: SPEC,
      eventData: { stepName: 'add', input: serialized([1]) },
    } as AnyEventRequest;
    await storage.events.create(runId, stepCreated, {
      inBand: true,
      expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
    });
    const before = await snapshotOf(runId);
    // world-local keeps step rows, so a second step_created for the same
    // step is refused (409) before anything is written.
    const error = await storage.events
      .create(runId, stepCreated, {
        inBand: true,
        expectedSeqInBand: before.snapshot?.seqInBand,
      })
      .catch((err: unknown) => err);
    expect(EntityConflictError.is(error)).toBe(true);
    expect(InBandSupersededError.is(error)).toBe(false);
    expect(await snapshotOf(runId)).toEqual(before);
  });

  it('counts an in-band write whose failure is ambiguous, so a stale writer cannot slip in', async () => {
    const runId = await createRun();
    const before = await snapshotOf(runId);
    // Refused without a status: the fence cannot tell it from a write that
    // landed and then failed, so it advances (the safe direction).
    await storage.events
      .create(
        runId,
        {
          eventType: 'step_started',
          correlationId: 'step_missing',
          specVersion: SPEC,
          eventData: { stepName: 'add', attempt: 1 },
        } as AnyEventRequest,
        { inBand: true, expectedSeqInBand: before.snapshot?.seqInBand }
      )
      .catch(() => undefined);
    const after = await snapshotOf(runId);
    expect(after.slots).toEqual(before.slots);
    expect(after.snapshot?.seqInBand).toBe(
      (before.snapshot?.seqInBand ?? 0) + 1
    );
  });

  it('keeps the counters on every page of a paginated load', async () => {
    const runId = await createRun();
    for (let i = 0; i < 3; i++) {
      await storage.events.create(runId, attrSet(String(i)));
    }
    const first = await storage.events.list({
      runId,
      pagination: { limit: 2 },
    });
    const second = await storage.events.list({
      runId,
      pagination: { limit: 2, cursor: first.cursor ?? undefined },
    });
    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.snapshot?.seq).toBe(4);
  });
});
