/**
 * world-sim's start Hook admission against the conformance suite every World
 * shares, plus the sim-only parts: the cross-region checkpoint, the orphan
 * bound on a virtual clock, and the fence.
 */

import {
  HookConflictError,
  HookReservedError,
  START_HOOK_ADMISSION_REJECTED,
} from '@workflow/errors';
import {
  type AnyEventRequest,
  SPEC_VERSION_CURRENT,
  START_HOOK_CANDIDATE_MAX_AGE_MS,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { atomicStartHookConformance } from '../../world/src/test-support/atomic-start-hook-conformance.js';
import { createIdFactory } from './ids.js';
import { createSimStore } from './store.js';
import { createSimWorld } from './world.js';

// The conformance suite sleeps through its retention windows in real time,
// so the store reads the real clock here, plus whatever the suite moved it
// by. Run ids are minted on the same clock: a candidate minted before a move
// ages by it, one minted after is fresh.
let clockOffsetMs = 0;
const realIds = createIdFactory(() => Date.now() + clockOffsetMs);
let current: ReturnType<typeof createSimStore> | undefined;
/** The next checkpoint never returns: its writer died mid-admission. */
let dieAtNextCheckpoint = false;

atomicStartHookConformance({
  name: 'world-sim',
  storage: () => {
    current = createSimStore({
      now: () => Date.now() + clockOffsetMs,
      ids: realIds,
      atomicStartHook: true,
      hookForceClaim: true,
      checkpoint: () => {
        if (!dieAtNextCheckpoint) return;
        dieAtNextCheckpoint = false;
        return new Promise<void>(() => {});
      },
    });
    return current;
  },
  capabilities: () => createSimWorld({ startHooks: true }).capabilities,
  newRunId: () => realIds.runId(),
  advanceClock: (ms) => {
    clockOffsetMs = ms === 0 ? 0 : clockOffsetMs + ms;
  },
  // The cross-region window: accepted, and the writer dies before its run.
  stageOrphan: async (runId, token) => {
    dieAtNextCheckpoint = true;
    void (
      current?.events.create as (
        runId: string,
        data: AnyEventRequest
      ) => Promise<unknown>
    )(runId, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_start_hook_conformance',
        workflowName: 'startHookConformance',
        input: new Uint8Array([1]),
        startHook: { token },
      },
    } as AnyEventRequest);
    await Promise.resolve();
  },
});

const SPEC = SPEC_VERSION_CURRENT;
const HOUR = 60 * 60 * 1000;

/** A store on a clock the test moves, and a checkpoint it can hold. */
function setup() {
  let now = 1_704_067_200_000;
  const ids = createIdFactory(() => now);
  const held: { name: string; release(): void }[] = [];
  let holdNext = false;
  const store = createSimStore({
    now: () => now,
    ids,
    atomicStartHook: true,
    hookForceClaim: true,
    checkpoint: (name) => {
      if (!holdNext) return;
      holdNext = false;
      return new Promise<void>((release) => {
        held.push({ name, release });
      });
    },
  });
  const create = (runId: string, data: AnyEventRequest) =>
    (
      store.events.create as (
        runId: string,
        data: AnyEventRequest
      ) => ReturnType<typeof store.events.create>
    )(runId, data);
  const creating = (eventType: 'run_created' | 'run_started', token: string) =>
    ({
      eventType,
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_sim',
        workflowName: 'wf',
        input: new Uint8Array([1]),
        startHook: { token },
      },
    }) as AnyEventRequest;
  return {
    store,
    ids,
    create,
    creating,
    advance: (ms: number) => {
      now += ms;
    },
    holdNextCheckpoint: () => {
      holdNext = true;
    },
    held,
  };
}

describe('start Hook admission (world-sim)', () => {
  it('holds a token for an accepted candidate whose run has not landed', async () => {
    const t = setup();
    const owner = t.ids.runId();
    t.holdNextCheckpoint();
    const pending = t.create(owner, t.creating('run_created', 'order:1'));
    await Promise.resolve();
    expect(t.held.map((h) => h.name)).toEqual(['start-hook:accepted']);

    // Decided but not created: the token is owned, and a lookup says so.
    const rival = t.ids.runId();
    const refused = await t
      .create(rival, t.creating('run_created', 'order:1'))
      .catch((e: unknown) => e);
    expect(HookConflictError.is(refused)).toBe(true);
    expect(refused).toMatchObject({ conflictingRunId: owner });
    const lookup = await t.store.hooks
      .getByToken('order:1')
      .catch((e: unknown) => e);
    expect(HookReservedError.is(lookup)).toBe(true);

    t.held[0].release();
    const created = await pending;
    expect(created.run?.runId).toBe(owner);
  });

  it('the queued copy finishes a creation the direct write died before', async () => {
    const t = setup();
    const candidate = t.ids.runId();
    t.holdNextCheckpoint();
    // The direct writer decides, then dies (never released).
    void t.create(candidate, t.creating('run_created', 'order:2'));
    await Promise.resolve();

    const started = await t.create(
      candidate,
      t.creating('run_started', 'order:2')
    );
    expect(started.run?.status).toBe('running');
    expect(t.store.allEvents(candidate).map((e) => e.eventType)).toEqual([
      'run_created',
      'run_started',
    ]);
  });

  it('releases an orphan once its window closes, fences it, and refuses its late attempt', async () => {
    const t = setup();
    const orphan = t.ids.runId();
    t.holdNextCheckpoint();
    void t.create(orphan, t.creating('run_created', 'order:3'));
    await Promise.resolve();

    t.advance(23 * HOUR);
    const early = await t
      .create(t.ids.runId(), t.creating('run_created', 'order:3'))
      .catch((e: unknown) => e);
    expect(early).toMatchObject({ conflictingRunId: orphan });

    t.advance(START_HOOK_CANDIDATE_MAX_AGE_MS);
    const contender = t.ids.runId();
    const admitted = await t.create(
      contender,
      t.creating('run_created', 'order:3')
    );
    expect(admitted.run?.runId).toBe(contender);
    expect(t.store.fencedCandidates()).toEqual([orphan]);

    const late = await t
      .create(orphan, t.creating('run_started', 'order:3'))
      .catch((e: unknown) => e);
    expect(late).toMatchObject({ code: START_HOOK_ADMISSION_REJECTED });
  });

  it('the fence refuses an orphan attempt that was already past its age check', async () => {
    const t = setup();
    const orphan = t.ids.runId();
    t.holdNextCheckpoint();
    void t.create(orphan, t.creating('run_created', 'order:4'));
    await Promise.resolve();

    // A redelivery passes row 0 just inside the window and stalls before its
    // run row.
    t.advance(START_HOOK_CANDIDATE_MAX_AGE_MS - 1);
    t.holdNextCheckpoint();
    const inFlight = t
      .create(orphan, t.creating('run_started', 'order:4'))
      .catch((e: unknown) => e);
    await Promise.resolve();
    expect(t.held).toHaveLength(2);

    // The window closes; a contender fences the orphan and takes the token.
    t.advance(2);
    const contender = t.ids.runId();
    await t.create(contender, t.creating('run_created', 'order:4'));

    t.held[1].release();
    expect(await inFlight).toMatchObject({
      code: START_HOOK_ADMISSION_REJECTED,
    });
    expect(t.store.allRuns().map((r) => r.runId)).toEqual([contender]);
  });

  it('keeps the default retention past the owner end on the virtual clock', async () => {
    const t = setup();
    const owner = t.ids.runId();
    const retention = new Date(1_704_067_200_000 + 24 * HOUR);
    await t.create(owner, {
      ...t.creating('run_created', 'order:5'),
      eventData: {
        ...(t.creating('run_created', 'order:5') as { eventData: object })
          .eventData,
        startHook: { token: 'order:5', tokenRetentionUntil: retention },
      },
    } as AnyEventRequest);
    await t.create(owner, {
      eventType: 'run_started',
      specVersion: SPEC,
    } as AnyEventRequest);
    await t.create(owner, {
      eventType: 'run_completed',
      specVersion: SPEC,
      eventData: { output: new Uint8Array([2]) },
    } as AnyEventRequest);

    expect(t.store.probeToken('order:5', retention.getTime() - 1)).toBe(owner);
    expect(t.store.probeToken('order:5', retention.getTime())).toBeUndefined();
  });
});
