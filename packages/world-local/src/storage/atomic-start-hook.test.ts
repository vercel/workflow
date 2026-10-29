/**
 * `start({ hook })` admission in the Local World: the start Hook's token
 * claim, the run and the Hook entity are written under the claim lock, and a
 * refusal is recorded per candidate.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HookConflictError,
  HookNotFoundError,
  START_HOOK_ADMISSION_REJECTED,
} from '@workflow/errors';
import {
  type AnyEventRequest,
  FIRST_EVENT_SLOT,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  startHookId,
} from '@workflow/world';
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
import { hookTokenClaimPath, START_HOOK_ORPHAN_GRACE_MS } from './helpers.js';
import { writeHookByRunMarker } from './hook-index.js';

const SPEC = SPEC_VERSION_CURRENT;

/**
 * The state a process killed between its start Hook claim and its run write
 * leaves: the by-run marker and the claim, and no run.
 */
async function stageOrphanClaim(
  dir: string,
  runId: string,
  token: string,
  reservedAt?: number
) {
  await writeHookByRunMarker(dir, runId, startHookId(runId));
  const claimPath = hookTokenClaimPath(dir, token);
  await fs.mkdir(path.dirname(claimPath), { recursive: true });
  await writeExclusive(
    claimPath,
    JSON.stringify(orphanClaim(runId, token, reservedAt))
  );
}

/** The token claim an admission writes before its run record. */
function orphanClaim(runId: string, token: string, reservedAt?: number) {
  return {
    token,
    runId,
    hookId: startHookId(runId),
    eventId: slotToEventId(FIRST_EVENT_SLOT),
    ...(reservedAt !== undefined ? { reservedAt } : {}),
  };
}
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
  stageOrphan: async (runId, token) => {
    const dir = currentDir;
    if (!dir) throw new Error('no storage set up');
    await stageOrphanClaim(dir, runId, token, Date.now());
  },
  // Accepted means the run record exists, so a claim whose run was never
  // written was never reported admitted; it holds only for the lock grace.
  orphanHoldMs: START_HOOK_ORPHAN_GRACE_MS,
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

  it('releases a start Hook claim whose writer died before creating its run', async () => {
    // The writer claimed the token and died before writing the run record:
    // no caller was ever told the candidate was admitted.
    const token = 'order:orphan';
    const orphan = `wrun_${ulid()}`;
    // Claimed long enough ago that the orphan grace has passed.
    await stageOrphanClaim(
      testDir,
      orphan,
      token,
      Date.now() - START_HOOK_ORPHAN_GRACE_MS - 1
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

  it('re-admits its own claim when the writer retries after dying mid-create', async () => {
    const token = 'order:retry';
    const runId = `wrun_${ulid()}`;
    await stageOrphanClaim(testDir, runId, token);

    const result = await create(runId, creating('run_created', token));
    expect(result.run?.runId).toBe(runId);
    expect(result.run?.startHook).toEqual({
      token,
      hookId: startHookId(runId),
    });
    expect(await storage.hooks.getByToken(token)).toMatchObject({
      hookId: startHookId(runId),
      runId,
    });
  });

  it('writes the start Hook entity, the claim and the indexes at admission', async () => {
    const token = 'order:written';
    const runId = `wrun_${ulid()}`;
    await create(runId, creating('run_created', token));
    const hookId = startHookId(runId);

    const entity = JSON.parse(
      await fs.readFile(path.join(testDir, 'hooks', `${hookId}.json`), 'utf8')
    );
    expect(entity).toMatchObject({
      runId,
      hookId,
      token,
      isWebhook: false,
    });
    expect(
      JSON.parse(await fs.readFile(hookTokenClaimPath(testDir, token), 'utf8'))
    ).toMatchObject({
      runId,
      hookId,
      eventId: slotToEventId(FIRST_EVENT_SLOT),
    });
  });

  it('rebuilds the start Hook from its run when its entity write was lost', async () => {
    const token = 'order:lost-entity';
    const owner = `wrun_${ulid()}`;
    await create(owner, creating('run_created', token));
    const hookId = startHookId(owner);
    const entityPath = path.join(testDir, 'hooks', `${hookId}.json`);
    // Lose the entity, as a crash between the run record and its write would.
    await fs.rm(entityPath);

    expect(await storage.hooks.getByToken(token)).toMatchObject({
      hookId,
      runId: owner,
      isWebhook: false,
    });
    await fs.rm(entityPath);
    expect(await storage.hooks.get(hookId)).toMatchObject({ hookId });
    await fs.rm(entityPath, { force: true });
    // A resume to the pending run still lands.
    const received = await create(owner, {
      eventType: 'hook_received',
      correlationId: hookId,
      specVersion: SPEC,
      eventData: { token, payload: new Uint8Array([1]) },
    } as AnyEventRequest);
    expect(received.event?.eventType).toBe('hook_received');

    // The run's end releases it like any Hook.
    await fs.rm(entityPath, { force: true });
    await create(owner, { eventType: 'run_started', specVersion: SPEC } as any);
    await create(owner, {
      eventType: 'run_completed',
      specVersion: SPEC,
      eventData: { output: new Uint8Array([2]) },
    } as AnyEventRequest);
    const next = `wrun_${ulid()}`;
    expect(
      (await create(next, creating('run_created', token))).run?.runId
    ).toBe(next);
  });

  it('answers the admission, not EntityConflictError, when a resume restored its run_created first', async () => {
    const token = 'order:early-resume';
    const owner = `wrun_${ulid()}`;
    const hookId = startHookId(owner);
    const other = createStorage(testDir);
    const realWriteExclusive = fsModule.writeExclusive;
    let resumed = false;
    const spy = vi
      .spyOn(fsModule, 'writeExclusive')
      .mockImplementation(async (filePath, data) => {
        if (
          !resumed &&
          filePath.includes(`${path.sep}events${path.sep}`) &&
          filePath.includes(owner) &&
          data.includes('"run_created"')
        ) {
          // Between the admission and the publish of its run_created, a
          // resume lands on the start Hook (and restores the run_created).
          resumed = true;
          await (
            other.events.create as (
              runId: string,
              data: AnyEventRequest
            ) => Promise<unknown>
          )(owner, {
            eventType: 'hook_received',
            correlationId: hookId,
            specVersion: SPEC,
            eventData: { token, payload: new Uint8Array([1]) },
          } as AnyEventRequest);
        }
        return realWriteExclusive(filePath, data);
      });
    try {
      const result = await create(owner, creating('run_created', token));
      expect(resumed).toBe(true);
      expect(result.run?.startHook).toMatchObject({ token, hookId });
      expect(result.event?.eventType).toBe('run_created');
    } finally {
      spy.mockRestore();
    }
    const log = await storage.events.list({ runId: owner });
    expect(log.data.map((event) => event.eventType)).toEqual([
      'run_created',
      'hook_received',
    ]);
  });

  it('restores the start Hook from its run_created when the claim and entity are lost', async () => {
    const token = 'order:lost-claim';
    const owner = `wrun_${ulid()}`;
    await create(owner, creating('run_created', token));
    await create(owner, { eventType: 'run_started', specVersion: SPEC } as any);
    await fs.rm(hookTokenClaimPath(testDir, token));
    await fs.rm(path.join(testDir, 'hooks', `${startHookId(owner)}.json`));

    // The token index points at the run_created that stands for the Hook.
    expect(await storage.hooks.getByToken(token)).toMatchObject({
      hookId: startHookId(owner),
      runId: owner,
      isWebhook: false,
    });
    const refused = await create(
      `wrun_${ulid()}`,
      creating('run_created', token)
    ).catch((e: unknown) => e);
    expect(refused).toMatchObject({ conflictingRunId: owner });
  });

  it('recovers from a crash between the token claim and the run write', async () => {
    // Kill the admission at the one point world-local leaves an orphan: the
    // token is claimed, the run record never written.
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
    ).toMatchObject({ runId: orphan, hookId: startHookId(orphan) });
    // Not a Hook: nobody was told it was admitted.
    expect(
      HookNotFoundError.is(
        await storage.hooks.getByToken(token).catch((e: unknown) => e)
      )
    ).toBe(true);
    expect(
      await storage.runs.get(orphan).then(
        () => true,
        () => false
      )
    ).toBe(false);

    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      // Just inside the orphan grace: the writer may be stalled, not dead,
      // so the claim still holds and a contender is refused naming it.
      vi.setSystemTime(Date.now() + START_HOOK_ORPHAN_GRACE_MS - 5_000);
      const early = `wrun_${ulid()}`;
      const refused = await create(early, creating('run_created', token)).catch(
        (e: unknown) => e
      );
      expect(HookConflictError.is(refused)).toBe(true);
      expect(refused).toMatchObject({ conflictingRunId: orphan });

      // Just past it: no caller was ever told the orphan was admitted, so a
      // contender owns the token.
      vi.setSystemTime(Date.now() + 10_000);
      const contender = `wrun_${ulid()}`;
      expect(
        (await create(contender, creating('run_created', token))).run?.runId
      ).toBe(contender);

      // The orphan's own late copies are refused: naming the contender
      // within the 24h bound, permanently past it.
      const within = await create(orphan, creating('run_started', token)).catch(
        (e: unknown) => e
      );
      expect(HookConflictError.is(within)).toBe(true);
      expect(within).toMatchObject({ conflictingRunId: contender });
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      const past = await create(orphan, creating('run_created', token)).catch(
        (e: unknown) => e
      );
      // Past the bound the World answers it, decided or not.
      expect(past).toMatchObject({ code: START_HOOK_ADMISSION_REJECTED });
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

  it('fences a writer stalled inside its run publication past the grace: it never becomes a run', async () => {
    const token = 'order:stalled';
    const stalled = `wrun_${ulid()}`;
    const realWriteExclusive = fsModule.writeExclusive;
    let reachedPublication!: () => void;
    const atPublication = new Promise<void>((r) => {
      reachedPublication = r;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    const pause = vi
      .spyOn(fsModule, 'writeExclusive')
      .mockImplementation(async (filePath, data) => {
        if (
          filePath.includes(`${path.sep}runs${path.sep}${stalled}`) &&
          !data.includes('startHookFence')
        ) {
          reachedPublication();
          await resumed;
        }
        return realWriteExclusive(filePath, data);
      });

    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      // A claims the token and stalls inside the run's publication.
      const a = create(stalled, creating('run_created', token)).catch(
        (e: unknown) => e
      );
      await atPublication;

      // Its lease is lost (a stalled process stops refreshing the lock) and
      // the orphan grace passes: B takes the token.
      await fs.rm(`${hookTokenClaimPath(testDir, token)}.lock`, {
        recursive: true,
        force: true,
      });
      vi.setSystemTime(Date.now() + START_HOOK_ORPHAN_GRACE_MS + 5_000);
      const contender = `wrun_${ulid()}`;
      expect(
        (await create(contender, creating('run_created', token))).run?.runId
      ).toBe(contender);

      // A resumes: its publication fails against the fence.
      resume();
      const outcome = await a;
      expect((outcome as { run?: unknown }).run).toBeUndefined();

      // Neither of A's copies can create it now.
      const queued = await create(
        stalled,
        creating('run_started', token)
      ).catch((e: unknown) => e);
      expect(HookConflictError.is(queued)).toBe(true);
      expect(queued).toMatchObject({ conflictingRunId: contender });
      const direct = await create(
        stalled,
        creating('run_created', token)
      ).catch((e: unknown) => e);
      expect(HookConflictError.is(direct)).toBe(true);
    } finally {
      pause.mockRestore();
      vi.useRealTimers();
    }

    expect(
      await storage.runs.get(stalled).then(
        () => true,
        () => false
      )
    ).toBe(false);
    const listed = await storage.runs.list({});
    expect(listed.data.map((r) => r.runId)).not.toContain(stalled);
    expect(listed.data.map((r) => r.runId)).toHaveLength(1);
  });

  it('answers not found for an orphan while it holds its token, and after', async () => {
    const token = 'order:looked-up';
    const orphan = `wrun_${ulid()}`;
    // A writer claimed the token and died before writing the run; its queued
    // copy has not been delivered yet.
    await stageOrphanClaim(testDir, orphan, token, Date.now());
    const lookup = () =>
      storage.hooks.getByToken(token).catch((e: unknown) => e);

    expect(HookNotFoundError.is(await lookup())).toBe(true);
    const early = await create(
      `wrun_${ulid()}`,
      creating('run_created', token)
    ).catch((e: unknown) => e);
    expect(early).toMatchObject({ conflictingRunId: orphan });

    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + START_HOOK_ORPHAN_GRACE_MS + 5_000);
      expect(HookNotFoundError.is(await lookup())).toBe(true);

      // The token is free for a new owner, and the orphan's late queued copy
      // can no longer create its run.
      const next = `wrun_${ulid()}`;
      expect(
        (await create(next, creating('run_created', token))).run?.runId
      ).toBe(next);
      const queued = await create(orphan, creating('run_started', token)).catch(
        (e: unknown) => e
      );
      expect(queued).toMatchObject({ conflictingRunId: next });
      expect((await storage.hooks.getByToken(token)).runId).toBe(next);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences a cancelled missing run only when it is an admitted start Hook candidate', async () => {
    const cancel = (runId: string) =>
      create(runId, {
        eventType: 'run_cancelled',
        specVersion: SPEC,
      } as AnyEventRequest).catch((e: unknown) => e);
    const runFile = (runId: string) =>
      fs
        .readdir(path.join(testDir, 'runs'))
        .then((names) => names.some((n) => n.startsWith(runId)))
        .catch(() => false);

    // An ordinary run id that does not exist yet: not found, nothing left
    // behind, and it can still be created.
    const ordinary = `wrun_${ulid()}`;
    expect(await cancel(ordinary)).toMatchObject({
      name: 'WorkflowRunNotFoundError',
    });
    expect(await runFile(ordinary)).toBe(false);
    const created = await create(ordinary, {
      eventType: 'run_created',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_local',
        workflowName: 'wf',
        input: new Uint8Array([1]),
      },
    } as AnyEventRequest);
    expect(created.run?.runId).toBe(ordinary);
    expect(await cancel('wrun_not-a-ulid')).toMatchObject({
      name: 'WorkflowRunNotFoundError',
    });

    // An admitted candidate whose writer died before its run: fenced.
    const token = 'order:cancelled';
    const young = `wrun_${ulid()}`;
    await stageOrphanClaim(testDir, young, token, Date.now());
    expect(await cancel(young)).toMatchObject({
      name: 'WorkflowRunNotFoundError',
    });
    expect(await runFile(young)).toBe(true);
    expect(
      (await storage.runs.list({})).data.some((r) => r.runId === young)
    ).toBe(false);
    expect(
      await create(young, creating('run_started', token)).catch(
        (e: unknown) => e
      )
    ).toMatchObject({ code: START_HOOK_ADMISSION_REJECTED });
    // The fence frees its token at once.
    const next = `wrun_${ulid()}`;
    expect(
      (await create(next, creating('run_created', token))).run?.runId
    ).toBe(next);

    // Past the orphan bound an id can never become a run: left alone.
    const old = `wrun_${ulid(Date.now() - 2 * 24 * 3600_000)}`;
    await stageOrphanClaim(testDir, old, 'order:old', Date.now());
    expect(await cancel(old)).toMatchObject({
      name: 'WorkflowRunNotFoundError',
    });
    expect(await runFile(old)).toBe(false);
  });

  it('refuses a queued candidate older than the orphan bound with a permanent code', async () => {
    const dayAgo = monotonicFactory()(Date.now() - 25 * 60 * 60 * 1000);
    const error = await create(
      `wrun_${dayAgo}`,
      creating('run_started', 'order:stale')
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: START_HOOK_ADMISSION_REJECTED,
      reason: 'expired',
    });
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
    expect(again).toMatchObject({
      code: START_HOOK_ADMISSION_REJECTED,
      reason: 'ordinary_run',
    });
  });

  it('logs decisions under DEBUG, naming runs but never the token', async () => {
    vi.stubEnv('DEBUG', 'workflow:*');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const token = 'order:secret-key';
      const owner = `wrun_${ulid()}`;
      const refused = `wrun_${ulid()}`;
      const next = `wrun_${ulid()}`;
      await create(owner, creating('run_created', token));
      await create(refused, creating('run_created', token)).catch(() => {});
      await create(owner, {
        eventType: 'run_cancelled',
        specVersion: SPEC,
      } as AnyEventRequest);
      await create(next, creating('run_created', token));

      const lines = debug.mock.calls.map((call) => JSON.stringify(call));
      const said = (message: string, detail: Record<string, string>) =>
        expect(debug).toHaveBeenCalledWith(
          `[world-local] start Hook: ${message}`,
          detail
        );
      said('accepted a candidate', { runId: owner });
      said('refused a candidate', { runId: refused, conflictingRunId: owner });
      said('accepted a candidate', { runId: next });
      expect(lines.some((line) => line.includes(token))).toBe(false);
    } finally {
      debug.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
