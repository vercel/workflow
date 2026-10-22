/**
 * `start({ hook })` admission in the Local World: the reservation rides on
 * the token claim file and the run is created under its lock, and a refusal
 * is recorded per candidate.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HookConflictError,
  HookReservedError,
  START_HOOK_ADMISSION_REJECTED,
} from '@workflow/errors';
import { type AnyEventRequest, SPEC_VERSION_CURRENT } from '@workflow/world';
import { monotonicFactory, ulid } from 'ulid';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { atomicStartHookConformance } from '../../../world/src/test-support/atomic-start-hook-conformance.js';
import * as fsModule from '../fs.js';
import { writeExclusive } from '../fs.js';
import { createWorld } from '../index.js';
import { createStorage } from '../storage.js';
import { hookTokenClaimPath } from './helpers.js';

const SPEC = SPEC_VERSION_CURRENT;
const conformanceDirs: string[] = [];
const storageDirs = new WeakMap<object, string>();
/** The data directory of the storage the current conformance test uses. */
let currentDir: string | undefined;

afterAll(() => {
  for (const dir of conformanceDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

atomicStartHookConformance({
  name: 'world-local',
  storage: () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wl-start-hook-conf-'));
    conformanceDirs.push(dir);
    const storage = createStorage(dir);
    storageDirs.set(storage.events, dir);
    currentDir = dir;
    return storage;
  },
  secondEvents: (first) => {
    const dir = storageDirs.get(first);
    if (!dir) throw new Error('unknown events storage');
    // Its own in-process locks: a second process on the same data directory.
    return createStorage(dir).events;
  },
  capabilities: () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wl-start-hook-caps-'));
    conformanceDirs.push(dir);
    return createWorld({ dataDir: dir }).capabilities;
  },
  newRunId: () => `wrun_${ulid()}`,
  advanceClock: (ms) => {
    if (ms === 0) {
      vi.useRealTimers();
      return;
    }
    const target = Date.now() + ms;
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(target);
  },
  // The state a process killed between its token claim and its run write
  // leaves: the claim, and no run.
  stageOrphan: async (runId, token) => {
    const dir = currentDir;
    if (!dir) throw new Error('no storage set up');
    const claimPath = hookTokenClaimPath(dir, token);
    await fs.mkdir(path.dirname(claimPath), { recursive: true });
    await writeExclusive(claimPath, JSON.stringify({ runId, reservation: {} }));
  },
  // Accepted means the run record exists, so a claim whose run was never
  // written was never reported admitted, and is released at once.
  orphanHoldsWithinWindow: false,
});

describe('atomic start Hook (world-local)', () => {
  let testDir: string;
  let storage: ReturnType<typeof createStorage>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-start-hook-'));
    storage = createStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const create = (runId: string, data: AnyEventRequest) =>
    (
      storage.events.create as (
        runId: string,
        data: AnyEventRequest
      ) => ReturnType<typeof storage.events.create>
    )(runId, data);

  const creating = (eventType: 'run_created' | 'run_started', token: string) =>
    ({
      eventType,
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_local',
        workflowName: 'wf',
        input: new Uint8Array([1]),
        startHook: { token },
      },
    }) as AnyEventRequest;

  it('releases a reservation whose writer died before creating its run', async () => {
    // The writer claimed the token and died before writing the run record:
    // no caller was ever told the candidate was admitted.
    const token = 'order:orphan';
    const orphan = `wrun_${ulid()}`;
    await fs.mkdir(path.dirname(hookTokenClaimPath(testDir, token)), {
      recursive: true,
    });
    await writeExclusive(
      hookTokenClaimPath(testDir, token),
      JSON.stringify({ runId: orphan, reservation: {} })
    );

    const next = `wrun_${ulid()}`;
    const result = await create(next, creating('run_created', token));
    expect(result.run?.runId).toBe(next);

    // The orphaned candidate decides again, and loses to the new owner.
    const error = await create(orphan, creating('run_started', token)).catch(
      (e: unknown) => e
    );
    expect(HookConflictError.is(error)).toBe(true);
    expect(error).toMatchObject({ conflictingRunId: next });
  });

  it('re-admits its own reservation when the writer retries after dying mid-create', async () => {
    const token = 'order:retry';
    const runId = `wrun_${ulid()}`;
    await fs.mkdir(path.dirname(hookTokenClaimPath(testDir, token)), {
      recursive: true,
    });
    await writeExclusive(
      hookTokenClaimPath(testDir, token),
      JSON.stringify({ runId, reservation: {} })
    );

    const result = await create(runId, creating('run_created', token));
    expect(result.run?.runId).toBe(runId);
    expect(result.run?.startHook).toEqual({ token });
  });

  /** A reserved, started run, and its claim rewritten as if mid-adoption. */
  async function midAdoption(token: string, metadata?: Uint8Array) {
    const runId = `wrun_${ulid()}`;
    await create(runId, {
      ...creating('run_created', token),
      eventData: {
        ...(creating('run_created', token) as any).eventData,
        startHook: { token, ...(metadata ? { metadata } : {}) },
      },
    } as AnyEventRequest);
    await create(runId, { eventType: 'run_started', specVersion: SPEC } as any);
    // The adopting createHook wrote the claim and died before publishing.
    const hookId = `hook_${ulid()}`;
    await fs.writeFile(
      hookTokenClaimPath(testDir, token),
      JSON.stringify({ runId, hookId, eventId: 'evnt_x', reservation: {} })
    );
    return { runId, hookId };
  }

  it('answers HookReservedError, not not-found, while an adoption is in flight', async () => {
    const token = 'order:mid-adoption';
    const { runId } = await midAdoption(token);

    const error = await storage.hooks
      .getByToken(token)
      .catch((e: unknown) => e);
    expect(HookReservedError.is(error)).toBe(true);
    expect(error).toMatchObject({ runId });
  });

  it('recovers an adoption that published hook_created but died before its entity write', async () => {
    const token = 'order:published-adoption';
    const owner = `wrun_${ulid()}`;
    await create(owner, creating('run_created', token));
    await create(owner, { eventType: 'run_started', specVersion: SPEC } as any);
    const hookId = `hook_${ulid()}`;
    await create(owner, {
      eventType: 'hook_created',
      correlationId: hookId,
      specVersion: SPEC,
      eventData: { token },
    } as AnyEventRequest);
    // Lose the entity, as a crash between the publish and its write would.
    await fs.rm(path.join(testDir, 'hooks', `${hookId}.json`));

    const hook = await storage.hooks.getByToken(token);
    expect(hook).toMatchObject({ hookId, runId: owner });
  });

  it('keeps the start Hook metadata when an interrupted adoption is retried', async () => {
    const token = 'order:retried-adoption';
    const metadata = new Uint8Array([4, 5, 6]);
    const { runId, hookId } = await midAdoption(token, metadata);

    const retried = await create(runId, {
      eventType: 'hook_created',
      correlationId: hookId,
      specVersion: SPEC,
      eventData: { token },
    } as AnyEventRequest);
    expect(retried.event?.eventType).toBe('hook_created');

    const hook = await storage.hooks.getByToken(token);
    expect(hook.metadata).toEqual(metadata);
  });

  it('recovers from a crash between the token claim and the run write', async () => {
    // Kill the admission at the one point world-local leaves an orphan: the
    // reservation is claimed, the run record never written.
    const token = 'order:crash';
    const orphan = `wrun_${ulid()}`;
    const realWriteExclusive = fsModule.writeExclusive;
    const crash = vi
      .spyOn(fsModule, 'writeExclusive')
      .mockImplementation(async (filePath, data) => {
        if (filePath.includes(`${path.sep}runs${path.sep}${orphan}`)) {
          throw new Error('process killed');
        }
        return realWriteExclusive(filePath, data);
      });
    const died = await create(orphan, creating('run_created', token)).catch(
      (e: unknown) => e
    );
    crash.mockRestore();
    expect((died as Error).message).toBe('process killed');
    expect(
      JSON.parse(await fs.readFile(hookTokenClaimPath(testDir, token), 'utf8'))
    ).toMatchObject({ runId: orphan, reservation: {} });
    expect(
      await storage.runs.get(orphan).then(
        () => true,
        () => false
      )
    ).toBe(false);

    // No caller was told the orphan was admitted, so a contender may own
    // the token at once.
    const contender = `wrun_${ulid()}`;
    expect(
      (await create(contender, creating('run_created', token))).run?.runId
    ).toBe(contender);

    // The orphan's own late copies are refused: naming the contender within
    // the bound, permanently past it.
    const within = await create(orphan, creating('run_started', token)).catch(
      (e: unknown) => e
    );
    expect(HookConflictError.is(within)).toBe(true);
    expect(within).toMatchObject({ conflictingRunId: contender });
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      const past = await create(orphan, creating('run_created', token)).catch(
        (e: unknown) => e
      );
      // Already decided (refused) for this candidate, so the refusal replays
      // unless the World answers the bound first; both are final.
      expect(
        HookConflictError.is(past) ||
          (past as { code?: string }).code === START_HOOK_ADMISSION_REJECTED
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(
      await storage.runs.get(orphan).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  it('refuses a queued candidate older than the orphan bound with a permanent code', async () => {
    const dayAgo = monotonicFactory()(Date.now() - 25 * 60 * 60 * 1000);
    const error = await create(
      `wrun_${dayAgo}`,
      creating('run_started', 'order:stale')
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: START_HOOK_ADMISSION_REJECTED });
  });

  it('refuses a candidate that already exists without the start Hook', async () => {
    const runId = `wrun_${ulid()}`;
    await create(runId, {
      eventType: 'run_created',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_local',
        workflowName: 'wf',
        input: new Uint8Array([1]),
      },
    } as AnyEventRequest);
    const error = await create(runId, creating('run_started', 'order:x')).then(
      () => undefined,
      (e: unknown) => e
    );
    // The run exists, so run_started takes the ordinary path and starts it;
    // a run_created for it with a start Hook is the contract violation.
    expect(error).toBeUndefined();
    const again = await create(runId, creating('run_created', 'order:x')).catch(
      (e: unknown) => e
    );
    expect(again).toMatchObject({ code: START_HOOK_ADMISSION_REJECTED });
  });
});
