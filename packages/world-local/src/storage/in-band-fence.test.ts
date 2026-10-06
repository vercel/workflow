/**
 * The in-band writer fence for single-orchestrator runs: an in-band write is
 * accepted only when its `expectedSeqInBand` matches the run's count, a
 * refusal writes nothing, out-of-band writes leave the count alone, and of
 * concurrent in-band writers holding the same count exactly one wins. `list`
 * reports the count as `snapshot.seqInBand`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EntityConflictError,
  IN_BAND_SUPERSEDED_CODE,
  InBandSupersededError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type AnyEventRequest,
  eventIdToSlot,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage } from '../storage.js';
import { IN_BAND_SEQ_AT_RUN_CREATION } from './events-storage.js';

const SPEC = SPEC_VERSION_SINGLE_ORCHESTRATOR;
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

function waitCreated(correlationId: string): AnyEventRequest {
  return {
    eventType: 'wait_created',
    correlationId,
    specVersion: SPEC,
    eventData: { resumeAt: new Date(Date.now() + 60_000) },
  } as AnyEventRequest;
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

describe('in-band fence (world-local)', () => {
  it('reports run_created as the only in-band position of a new run', async () => {
    const runId = await createRun();
    const { snapshot, slots } = await snapshotOf(runId);
    expect(snapshot).toEqual({
      seq: 1,
      seqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
    });
    expect(slots).toEqual([1]);
  });

  it('accepts an in-band write at the current count and advances it by one', async () => {
    const runId = await createRun();
    const started = await storage.events.create(
      runId,
      { eventType: 'run_started', specVersion: SPEC } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION }
    );
    expect(started.event?.eventType).toBe('run_started');
    await storage.events.create(runId, waitCreated('wait_1'), {
      inBand: true,
      expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION + 1,
    });
    const { snapshot } = await snapshotOf(runId);
    expect(snapshot).toEqual({
      seq: 3,
      seqInBand: IN_BAND_SEQ_AT_RUN_CREATION + 2,
    });
  });

  it('refuses a stale in-band write with InBandSupersededError and writes nothing', async () => {
    const runId = await createRun();
    await storage.events.create(
      runId,
      { eventType: 'run_started', specVersion: SPEC } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION }
    );
    const before = await snapshotOf(runId);

    const error = await storage.events
      .create(runId, waitCreated('wait_1'), {
        inBand: true,
        // The count before run_started: a writer that has not seen it.
        expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
      })
      .catch((err: unknown) => err);

    expect(InBandSupersededError.is(error)).toBe(true);
    expect(error).toMatchObject({
      status: 412,
      code: IN_BAND_SUPERSEDED_CODE,
      seqInBand: before.snapshot?.seqInBand,
    });
    // Nothing allocated: same slots, same counters, and the next write lands
    // in the very next slot.
    expect(await snapshotOf(runId)).toEqual(before);
    const next = await storage.events.create(runId, waitCreated('wait_1'), {
      inBand: true,
      expectedSeqInBand: before.snapshot?.seqInBand,
    });
    expect(slotOf(next.event as { eventId: string })).toBe(
      (before.snapshot?.seq ?? 0) + 1
    );
  });

  it('leaves the count alone for out-of-band writes, which carry no expected count', async () => {
    const runId = await createRun();
    const before = await snapshotOf(runId);
    await storage.events.create(runId, attrSet('a'), { inBand: false });
    await storage.events.create(runId, attrSet('b'));
    const after = await snapshotOf(runId);
    expect(after.snapshot?.seqInBand).toBe(before.snapshot?.seqInBand);
    expect(after.snapshot?.seq).toBe((before.snapshot?.seq ?? 0) + 2);
    // ...so an in-band writer that loaded before them is still current.
    await expect(
      storage.events.create(
        runId,
        { eventType: 'run_started', specVersion: SPEC } as AnyEventRequest,
        { inBand: true, expectedSeqInBand: before.snapshot?.seqInBand }
      )
    ).resolves.toBeDefined();
  });

  it('lets exactly one of several concurrent in-band writers with the same count win', async () => {
    const runId = await createRun();
    const { snapshot } = await snapshotOf(runId);
    const writers = 8;
    const outcomes = await Promise.allSettled(
      Array.from({ length: writers }, (_, i) =>
        storage.events.create(runId, waitCreated(`wait_${i}`), {
          inBand: true,
          expectedSeqInBand: snapshot?.seqInBand,
        })
      )
    );
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter(
      (o) => o.status === 'rejected' && InBandSupersededError.is(o.reason)
    );
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(writers - 1);
    const after = await snapshotOf(runId);
    expect(after.slots).toEqual([1, 2]);
    expect(after.snapshot?.seqInBand).toBe((snapshot?.seqInBand ?? 0) + 1);
  });

  it('rejects an in-band write that carries no expected count', async () => {
    const runId = await createRun();
    const error = await storage.events
      .create(runId, waitCreated('wait_1'), { inBand: true })
      .catch((err: unknown) => err);
    expect(WorkflowWorldError.is(error)).toBe(true);
    expect((error as WorkflowWorldError).status).toBe(400);
    expect((await snapshotOf(runId)).slots).toEqual([1]);
  });

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
          eventData: { stepName: 'add', attempt: 1, startReason: 'first' },
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

  it('records the single-orchestrator step bookkeeping on the stored events', async () => {
    const runId = await createRun();
    await storage.events.create(
      runId,
      {
        eventType: 'step_created',
        correlationId: 'step_1',
        specVersion: SPEC,
        eventData: {
          stepName: 'add',
          input: serialized([1]),
          inline: true,
          creatorMessageId: 'msg_creator',
        },
      } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION }
    );
    await storage.events.create(
      runId,
      {
        eventType: 'step_started',
        correlationId: 'step_1',
        specVersion: SPEC,
        eventData: { stepName: 'add', attempt: 1, startReason: 'first' },
      } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION + 1 }
    );
    const page = await storage.events.list({ runId });
    const [created, started] = page.data.slice(1);
    expect(created?.eventData).toMatchObject({
      inline: true,
      creatorMessageId: 'msg_creator',
    });
    expect(started?.eventData).toMatchObject({
      stepName: 'add',
      attempt: 1,
      startReason: 'first',
    });
  });
});
