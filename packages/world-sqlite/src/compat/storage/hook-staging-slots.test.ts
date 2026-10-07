import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  SPEC_VERSION_CURRENT,
  type Storage,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHook, createRun } from '../test-helpers.js';

import { createStorage } from './index.js';

// world-sqlite: SQLite transactions replace exclusive staging/promote gates.
// `hook_received` is the one event that does not publish straight into
// `events/`: it stages the file under `.locks` first, so a terminal
// transition can reap it before it ever becomes reader-visible. The staging
// path is the only place a slot can be held OUTSIDE `events/`, and the slot
// allocator only probes `events/`. So a staging collision is not evidence
// that the slot is taken, and treating it as one moves the writer off a
// position nothing will ever fill.
describe('world-local hook_received staging and slot density', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-staging-test-'));
    storage = createStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function setup() {
    const run = await createRun(storage, {
      deploymentId: 'dpl_test',
      workflowName: 'test-workflow',
      input: new Uint8Array(),
    });
    const hook = await createHook(storage, run.runId, {
      hookId: 'hook_1',
      token: 'order:1',
    });
    return { runId: run.runId, hook };
  }

  function resume(
    runId: string,
    hook: { hookId: string; token: string },
    resumeId: string,
    payload: Uint8Array
  ) {
    return storage.events.create(
      runId,
      {
        eventType: 'hook_received',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: hook.hookId,
        eventData: { token: hook.token, payload },
      },
      { resumeId, resumePayloadDigest: resumeId }
    );
  }

  async function slots(runId: string): Promise<number[]> {
    const { data } = await storage.events.list({
      runId,
      pagination: { limit: 1000 },
    });
    return data.map((event) => eventIdToSlot(event.eventId) ?? -1);
  }

  // world-sqlite: filesystem layout/claim/cache mechanics have no SQLite equivalent.

  it('returns the committed event to the loser of a raced resume', async () => {
    const { runId, hook } = await setup();
    const other = createStorage(testDir);

    // world-sqlite: race public resume requests without a stale claim file.
    // Both writers of one resume adopt the claim's position, so the loser of
    // the publish finds the winner's event there. That is the convergence the
    // adoption exists to force, and the dedup contract is that both writers
    // return the one committed event — reporting a conflict instead leaves
    // the caller with an error it cannot act on for a resume that did land.
    const [first, second] = await Promise.all([
      resume(runId, hook, 'resume_1', new Uint8Array([1])),
      other.events.create(
        runId,
        {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hook.hookId,
          eventData: { token: hook.token, payload: new Uint8Array([1]) },
        },
        { resumeId: 'resume_1', resumePayloadDigest: 'resume_1' }
      ),
    ]);

    expect(second.event.eventId).toBe(first.event.eventId);
    const { data } = await storage.events.list({ runId });
    expect(data.filter((e) => e.eventType === 'hook_received')).toHaveLength(1);
  });

  it('writes one event when the claim owner loses the position to an adopter', async () => {
    const { runId, hook } = await setup();
    const other = createStorage(testDir);

    // Only one of the two takers of a claim is pinned. The taker that WRITES
    // the claim keeps its own id, unpinned, because a slot is a position that
    // another instance also hands out for unrelated events, and refusing to
    // move would fail this resume's append outright. The taker that ADOPTS an
    // existing claim is pinned to the claimed position.
    //
    // So the loser of the promote can be the unpinned owner, and a loser that
    // bumps publishes a second `hook_received` for one resumeId. Nothing in
    // the log looks wrong afterwards (it stays dense, both callers report
    // success) but the resume is delivered twice on replay.
    //
    // The gate parks whichever caller reaches the promote first until the
    // other has linked. The owner gets there first on its own: the adopter
    // reads the claim and scans for a committed event before it stages.
    const results = await Promise.all([
      resume(runId, hook, 'resume_1', new Uint8Array([1])),
      other.events.create(
        runId,
        {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hook.hookId,
          eventData: { token: hook.token, payload: new Uint8Array([1]) },
        },
        { resumeId: 'resume_1', resumePayloadDigest: 'resume_1' }
      ),
    ]);

    const { data } = await storage.events.list({ runId });
    expect(data.filter((e) => e.eventType === 'hook_received')).toHaveLength(1);
    // Both takers answer with the one committed event, which is the dedup
    // contract the caller relies on to treat a redelivery as a no-op.
    expect(results[1].event.eventId).toBe(results[0].event.eventId);
  });

  it('keeps the log dense under live contention on one position', async () => {
    const { runId, hook } = await setup();
    // Density here is not a regression guard: with two LIVE stagers and no
    // terminal transition, the pre-fix code also ended dense, because the
    // writer it bumped off the position was the one that went on to publish
    // it. The hole needs the stager to be rejected or killed, which is what
    // the crashed-attempt test above stages.
    //
    // What this does cover is that arbitrating at the promote (rather than at
    // the staging write) still resolves two instances drawing one position,
    // which is the configuration this backend supports for the CLI plus the
    // app: each instance's allocator watermark is its own, so both hand out
    // the same candidate.
    const other = createStorage(testDir);

    await Promise.all([
      resume(runId, hook, 'resume_a', new Uint8Array([1])),
      other.events.create(
        runId,
        {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hook.hookId,
          eventData: { token: hook.token, payload: new Uint8Array([2]) },
        },
        { resumeId: 'resume_b', resumePayloadDigest: 'resume_b' }
      ),
    ]);

    const published = await slots(runId);
    expect(published).toEqual(
      published.map((_, index) => index + FIRST_EVENT_SLOT)
    );
  });
});
