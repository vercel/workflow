import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
} from '@workflow/world';
import { expect, onTestFinished, test, vi } from 'vitest';
import { createFetcher, startServer } from '../src/util.mjs';
import type { Hook } from '../workflows/hooks.ts';

const SPEC_8 = String(SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM);

/**
 * Starts a Local World server on `dataDir` that mints `specVersion`
 * (`undefined` leaves `WORKFLOW_SPEC_VERSION` unset, so the server mints the
 * default, spec 9).
 */
async function serverAt(dataDir: string, specVersion: string | undefined) {
  return createFetcher(
    await startServer({
      world: 'local',
      env: {
        WORKFLOW_SPEC_VERSION: specVersion,
        WORKFLOW_LOCAL_DATA_DIR: dataDir,
      },
    })
  );
}

type Server = Awaited<ReturnType<typeof serverAt>>;

/** Starts a run that parks on a hook, and waits until the hook exists. */
async function parkOnHook(server: Server, token: string) {
  const { runId } = await server.invoke(
    'workflows/hooks.ts',
    'collectWithHook',
    [token, 'custom']
  );
  await vi.waitFor(
    async () => {
      const events = await server.getEvents(runId);
      expect(events.some((e) => e.eventType === 'hook_created')).toBe(true);
    },
    { interval: 200, timeout: 20_000 }
  );
  return runId;
}

async function completedRun(server: Server, runId: string) {
  return vi.waitFor(
    async () => {
      const run = await server.getRun(runId);
      expect(run.status).toBe('completed');
      return run;
    },
    { interval: 200, timeout: 30_000 }
  );
}

/** Whether the log, after the hook resume, holds a `step_created`. */
async function stepCreatedAfterResume(server: Server, runId: string) {
  const events = await server.getEvents(runId);
  const resumedAt = events.findIndex((e) => e.eventType === 'hook_received');
  expect(resumedAt).toBeGreaterThan(0);
  return events.slice(resumedAt).some((e) => e.eventType === 'step_created');
}

async function freshRunSpecVersion(server: Server) {
  const { runId } = await server.invoke(
    'workflows/addition.ts',
    'addition',
    [1, 2]
  );
  return (await completedRun(server, runId)).specVersion;
}

function tempDataDir() {
  return mkdtemp(join(tmpdir(), 'workflow-spec-upgrade-')).then((dir) => {
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    return dir;
  });
}

// The upgrade users do: a Local World that created a spec 8 run (an earlier
// release, here `WORKFLOW_SPEC_VERSION=8`) is restarted with the variable
// unset while the run waits on a hook. The restarted server keeps driving the
// run with the spec 8 orchestrator, and its new runs are spec 9, the default.
test(
  'a spec 8 run in flight finishes after its World upgrades to the spec 9 default',
  { timeout: 60_000 },
  async () => {
    const dataDir = await tempDataDir();
    const before = await serverAt(dataDir, SPEC_8);
    const token = `upgrade-${Date.now().toString(36)}`;
    const runId = await parkOnHook(before, token);

    const after = await serverAt(dataDir, undefined);
    await after.resumeHook<typeof Hook>(token, { data: 'last', done: true });

    const run = await completedRun(after, runId);
    expect(run.specVersion).toBe(SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM);
    // The step after the resume was written in the spec 8 shape (its own
    // `step_created`), so the spec 8 orchestrator drove it.
    expect(await stepCreatedAfterResume(after, runId)).toBe(true);

    expect(await freshRunSpecVersion(after)).toBe(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
  }
);

// The documented opt-out: a Local World that created a spec 9 run at the
// default is restarted with `WORKFLOW_SPEC_VERSION=8` while the run waits on
// a hook. The restarted server keeps driving the run with the spec 9
// orchestrator, and its new runs are spec 8.
test(
  'a spec 9 run in flight finishes after its World opts out with WORKFLOW_SPEC_VERSION=8',
  { timeout: 60_000 },
  async () => {
    const dataDir = await tempDataDir();
    const before = await serverAt(dataDir, undefined);
    const token = `opt-out-${Date.now().toString(36)}`;
    const runId = await parkOnHook(before, token);

    const after = await serverAt(dataDir, SPEC_8);
    await after.resumeHook<typeof Hook>(token, { data: 'last', done: true });

    const run = await completedRun(after, runId);
    expect(run.specVersion).toBe(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    // A spec 9 inline step is created by its `step_started` alone, so no
    // `step_created` after the resume shows the spec 9 orchestrator drove it.
    expect(await stepCreatedAfterResume(after, runId)).toBe(false);

    expect(await freshRunSpecVersion(after)).toBe(
      SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM
    );
  }
);
