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

// A Local World that created a spec 8 run is restarted with spec 9 opted in
// (`WORKFLOW_SPEC_VERSION=9`) while the run waits on a hook. The restarted
// server keeps driving the run with the spec 8 orchestrator, and its new runs
// are spec 9.
test(
  'a spec 8 run in flight finishes after its World opts in to spec 9',
  { timeout: 60_000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workflow-spec8-upgrade-'));
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

    const before = await startServer({
      world: 'local',
      env: {
        WORKFLOW_SPEC_VERSION: String(SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM),
        WORKFLOW_LOCAL_DATA_DIR: dataDir,
      },
    }).then(createFetcher);
    const token = `upgrade-${Date.now().toString(36)}`;
    const { runId } = await before.invoke(
      'workflows/hooks.ts',
      'collectWithHook',
      [token, 'custom']
    );
    await vi.waitFor(
      async () => {
        const events = await before.getEvents(runId);
        expect(events.some((e) => e.eventType === 'hook_created')).toBe(true);
      },
      { interval: 200, timeout: 20_000 }
    );

    const after = await startServer({
      world: 'local',
      env: {
        WORKFLOW_SPEC_VERSION: String(SPEC_VERSION_SINGLE_ORCHESTRATOR),
        WORKFLOW_LOCAL_DATA_DIR: dataDir,
      },
    }).then(createFetcher);
    await after.resumeHook<typeof Hook>(token, { data: 'last', done: true });

    const run = await vi.waitFor(
      async () => {
        const run = await after.getRun(runId);
        expect(run.status).toBe('completed');
        return run;
      },
      { interval: 200, timeout: 30_000 }
    );
    expect(run.specVersion).toBe(SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM);
    // The step after the resume was written in the spec 8 shape (its own
    // `step_created`), so the spec 8 orchestrator drove it.
    const events = await after.getEvents(runId);
    const resumedAt = events.findIndex((e) => e.eventType === 'hook_received');
    expect(resumedAt).toBeGreaterThan(0);
    expect(
      events.slice(resumedAt).some((e) => e.eventType === 'step_created')
    ).toBe(true);

    // A new run on the opted-in World is a single-orchestrator run.
    const fresh = await after.invoke(
      'workflows/addition.ts',
      'addition',
      [1, 2]
    );
    const freshRun = await vi.waitFor(
      async () => {
        const r = await after.getRun(fresh.runId);
        expect(r.status).toBe('completed');
        return r;
      },
      { interval: 200, timeout: 25_000 }
    );
    expect(freshRun.specVersion).toBe(SPEC_VERSION_SINGLE_ORCHESTRATOR);
  }
);
