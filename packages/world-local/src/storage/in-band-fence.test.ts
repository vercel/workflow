/**
 * The in-band writer fence: an in-band write is
 * accepted only when its `expectedSeqInBand` matches the run's count, a
 * refusal writes nothing, out-of-band writes leave the count alone, and of
 * concurrent in-band writers holding the same count exactly one wins. `list`
 * reports the count as `snapshot.seqInBand`.
 */

import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const eventsDirs = new WeakMap<object, string>();
afterAll(() => {
  for (const dir of conformanceDirs)
    rmSync(dir, { recursive: true, force: true });
});
inBandFenceConformance({
  name: 'world-local',
  events: () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wl-fence-conf-'));
    conformanceDirs.push(dir);
    const events = createStorage(dir).events;
    eventsDirs.set(events, dir);
    return events;
  },
  secondEvents: (first) => {
    const dir = eventsDirs.get(first);
    if (!dir) throw new Error('unknown events storage');
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

  it('keeps the count on disk: a dead writer between its check and its publish is counted, and a snapshot reports the count without it', async () => {
    const runId = await createRun();
    // What a writer that died after the fence accepted it, and before it
    // finished, leaves behind.
    await fs.mkdir(path.join(testDir, '.locks', 'runs'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.locks', 'runs', `${runId}.in-band`),
      JSON.stringify({ seqInBand: 1, pending: 1 })
    );
    expect((await snapshotOf(runId)).snapshot?.seqInBand).toBe(1);
    // A writer at that count may have been the dead one's stale sibling: refused.
    const error = await storage.events
      .create(runId, attrSet('stale'), { inBand: true, expectedSeqInBand: 1 })
      .catch((err: unknown) => err);
    expect(InBandSupersededError.is(error)).toBe(true);
    expect((error as InBandSupersededError).seqInBand).toBe(2);
    expect((await snapshotOf(runId)).snapshot?.seqInBand).toBe(2);
    await storage.events.create(runId, attrSet('next'), {
      inBand: true,
      expectedSeqInBand: 2,
    });
    // Another storage instance (a restart, another process) reads the same count.
    const reopened = createStorage(testDir);
    const page = await reopened.events.list({ runId });
    expect(page.snapshot?.seqInBand).toBe(3);
  });

  describe('across OS processes on one data directory', () => {
    const child = fileURLToPath(
      new URL('./in-band-fence.child.mjs', import.meta.url)
    );
    type Answer = {
      status: 'accepted' | 'refused' | 'error';
      seqInBand?: number;
      message?: string;
    };
    /** A process on `testDir`, ready to make one in-band write at `expected` when told to. */
    async function otherProcess(runId: string, expected: number) {
      const proc = fork(
        child,
        [testDir, runId, String(expected), String(SPEC)],
        {
          // Node's own type stripping, nothing inherited from the test runner.
          execArgv: [],
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        }
      );
      const answers: Answer[] = [];
      const next = () =>
        new Promise<Answer>((resolve, reject) => {
          const queued = answers.shift();
          if (queued) return resolve(queued);
          proc.once('message', (m) => resolve(m as Answer));
          proc.once('exit', (code) =>
            reject(new Error(`child exited (${code}) without answering`))
          );
        });
      expect((await next()).status).toBe('ready');
      return {
        write() {
          const answer = next();
          proc.send('go');
          return answer;
        },
      };
    }

    it('a stale writer in this process is refused after another process wrote in-band', async () => {
      const runId = await createRun();
      const { snapshot } = await snapshotOf(runId);
      const loaded = snapshot?.seqInBand as number;
      const other = await otherProcess(runId, loaded);
      expect(await other.write()).toMatchObject({ status: 'accepted' });
      // This process decided from its load, before the other one wrote.
      const error = await storage.events
        .create(runId, attrSet('stale'), {
          inBand: true,
          expectedSeqInBand: loaded,
        })
        .catch((err: unknown) => err);
      expect(InBandSupersededError.is(error)).toBe(true);
      expect((error as InBandSupersededError).seqInBand).toBe(loaded + 1);
      const after = await snapshotOf(runId);
      expect(after.snapshot?.seqInBand).toBe(loaded + 1);
      // The refused write left nothing behind.
      expect(after.slots).toEqual([1, 2]);
    }, 30_000);

    it('of writers in several processes holding the same count, exactly one is accepted', async () => {
      const runId = await createRun();
      const { snapshot } = await snapshotOf(runId);
      const loaded = snapshot?.seqInBand as number;
      const others = await Promise.all(
        [1, 2, 3].map(() => otherProcess(runId, loaded))
      );
      const answers = await Promise.all([
        ...others.map((o) => o.write()),
        storage.events
          .create(runId, attrSet('here'), {
            inBand: true,
            expectedSeqInBand: loaded,
          })
          .then(
            (): Answer => ({ status: 'accepted' }),
            (err: unknown): Answer => ({
              status: InBandSupersededError.is(err) ? 'refused' : 'error',
              message: String(err),
            })
          ),
      ]);
      expect(answers.filter((a) => a.status === 'error')).toEqual([]);
      expect(answers.filter((a) => a.status === 'accepted')).toHaveLength(1);
      expect(answers.filter((a) => a.status === 'refused')).toHaveLength(3);
      const after = await snapshotOf(runId);
      expect(after.snapshot?.seqInBand).toBe(loaded + 1);
      expect(after.slots).toEqual([1, 2]);
    }, 30_000);
  });
});
