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
import { hookResumeClaimPath, pendingHookEventPath } from './helpers.js';
import { createStorage } from './index.js';

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

  it('leaves no hole when a crashed attempt still holds the staging path', async () => {
    const { runId, hook } = await setup();

    // A process killed between staging and promoting leaves its staged file
    // behind: the cleanup lives in a `finally` the kill skips, and the only
    // other reaper runs on a terminal transition this run has not reached.
    // The file names the slot the crashed attempt drew, which is the slot the
    // next writer draws too, because `events/` never saw it.
    const drawn = (await slots(runId)).length + FIRST_EVENT_SLOT;
    const stale = pendingHookEventPath(
      testDir,
      runId,
      `evnt_${String(drawn).padStart(26, '0')}`
    );
    await fs.mkdir(path.dirname(stale), { recursive: true });
    await fs.writeFile(stale, '{}');

    await resume(runId, hook, 'resume_1', new Uint8Array([1]));

    // Slot ids are positions, so the log is only readable if it is dense: the
    // runtime reads a missing position as a durable hole and fails the run
    // with CORRUPTED_EVENT_LOG.
    const published = await slots(runId);
    expect(published).toEqual(
      published.map((_, index) => index + FIRST_EVENT_SLOT)
    );
  });

  it('returns the committed event to the loser of a raced resume', async () => {
    const { runId, hook } = await setup();
    const other = createStorage(testDir);

    // A claim with no event behind it is the crash window the adoption path
    // exists for: its writer recorded where it meant to append and died. Both
    // takers below therefore adopt that position instead of drawing their own.
    const drawn = (await slots(runId)).length + FIRST_EVENT_SLOT;
    await fs.mkdir(
      path.dirname(hookResumeClaimPath(testDir, runId, 'resume_1')),
      {
        recursive: true,
      }
    );
    await fs.writeFile(
      hookResumeClaimPath(testDir, runId, 'resume_1'),
      JSON.stringify({
        runId,
        resumeId: 'resume_1',
        hookId: hook.hookId,
        eventId: `evnt_${String(drawn).padStart(26, '0')}`,
        payloadDigest: 'resume_1',
      })
    );

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

  it('keeps the log dense when two instances resume the same hook at once', async () => {
    const { runId, hook } = await setup();
    // A second instance over the same directory is the configuration this
    // backend supports for the CLI plus the app. Its allocator watermark is
    // its own, so both instances hand out the same candidate position.
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
