/**
 * `start({ hook })` admission in the Local World: the start Hook's token,
 * the run, its Hook and its run_created commit in one transaction, and a
 * refusal is recorded per candidate.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HookConflictError,
  START_HOOK_ADMISSION_REJECTED,
} from '@workflow/errors';
import {
  type AnyEventRequest,
  SPEC_VERSION_CURRENT,
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
import { createWorld } from '../index.js';
import { createStorage } from '../storage.js';

const SPEC = SPEC_VERSION_CURRENT;

const conformanceDirs: string[] = [];
const storageDirs = new WeakMap<object, string>();

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
  // Hook retention is compared against `Date.now()`.
  retentionReadsAdvanceClock: true,
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

  it('writes the start Hook with its run, so it resolves at once', async () => {
    const runId = `wrun_${ulid()}`;
    const created = await create(runId, creating('run_created', 'order:1'));
    expect(created.run?.startHook).toMatchObject({
      token: 'order:1',
      hookId: startHookId(runId),
    });
    expect(await storage.hooks.getByToken('order:1')).toMatchObject({
      runId,
      hookId: startHookId(runId),
    });
    // Its creation is the run's run_created, at the first position.
    const page = await storage.events.list({ runId });
    expect(page.data.map((event) => event.eventType)).toEqual(['run_created']);
  });

  it('records a refusal, and answers it again once the token is free', async () => {
    const owner = `wrun_${ulid()}`;
    const refused = `wrun_${ulid()}`;
    await create(owner, creating('run_created', 'order:2'));
    const first = await create(
      refused,
      creating('run_created', 'order:2')
    ).catch((e: unknown) => e);
    expect(HookConflictError.is(first)).toBe(true);
    await create(owner, {
      eventType: 'run_cancelled',
      specVersion: SPEC,
    } as AnyEventRequest);
    // The queued copy decides the same way, though the token is free now.
    const again = await create(
      refused,
      creating('run_started', 'order:2')
    ).catch((e: unknown) => e);
    expect(HookConflictError.is(again)).toBe(true);
    expect((again as HookConflictError).conflictingRunId).toBe(owner);
    await expect(storage.runs.get(refused)).rejects.toThrow();
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
