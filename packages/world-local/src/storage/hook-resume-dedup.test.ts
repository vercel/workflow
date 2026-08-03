import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_CURRENT, type Storage } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHook, createRun } from '../test-helpers.js';
import { createStorage } from './index.js';

// When a run carries the `hookResumeInputVersion` marker, the parallel resume
// path has TWO writers of the same `hook_received`: the direct `events.create`
// and the queue consumer's re-ensure. Both carry the same `resumeId`.
// world-local (the dev backend) must converge them onto exactly one event —
// mirroring the server's `(runId, resumeId)` constraint — or a dev run would
// replay a duplicated hook_received.
describe('world-local hook_received resume dedup', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-resume-test-'));
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

  async function countHookReceived(runId: string): Promise<number> {
    const { data } = await storage.events.list({ runId });
    return data.filter((e) => e.eventType === 'hook_received').length;
  }

  function resume(
    runId: string,
    hook: { hookId: string; token: string },
    resumeId: string,
    payloadDigest: string,
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
      { resumeId, resumePayloadDigest: payloadDigest }
    );
  }

  it('collapses the two writers of ONE resume onto a single event', async () => {
    const { runId, hook } = await setup();
    const payload = new Uint8Array([1, 2, 3]);

    // Both the producer's direct write and the consumer's re-ensure carry the
    // SAME resumeId + digest — they must converge on one committed event.
    const first = await resume(runId, hook, 'resume_1', 'digest_1', payload);
    const second = await resume(runId, hook, 'resume_1', 'digest_1', payload);

    expect(second.event.eventId).toBe(first.event.eventId);
    expect(await countHookReceived(runId)).toBe(1);

    // The persisted event carries the resume key so the queue consumer can
    // detect this write already landed in its preload and skip the re-ensure.
    expect(first.event.resumeId).toBe('resume_1');
    expect(second.event.resumeId).toBe('resume_1');
  });

  it('keeps distinct resumes of a reusable hook as separate events', async () => {
    const { runId, hook } = await setup();

    // A reusable hook (AsyncIterable) receives many resumes under the same
    // hookId. Keying dedup on the hookId would wrongly collapse them; keying
    // on (runId, resumeId) keeps each resume its own event.
    const first = await resume(
      runId,
      hook,
      'resume_1',
      'digest_1',
      new Uint8Array([1])
    );
    const second = await resume(
      runId,
      hook,
      'resume_2',
      'digest_2',
      new Uint8Array([2])
    );

    expect(second.event.eventId).not.toBe(first.event.eventId);
    expect(await countHookReceived(runId)).toBe(2);
  });

  it('rejects a reused resumeId that carries a different payload', async () => {
    const { runId, hook } = await setup();

    await resume(runId, hook, 'resume_1', 'digest_1', new Uint8Array([1]));

    // Same resumeId, different digest → the resume key was reused for a
    // different payload. That is a caller bug, not a benign redelivery.
    await expect(
      resume(runId, hook, 'resume_1', 'digest_2', new Uint8Array([2]))
    ).rejects.toThrow();
    expect(await countHookReceived(runId)).toBe(1);
  });

  it('rejects a reused resumeId + digest that belongs to a DIFFERENT hook', async () => {
    const { runId, hook } = await setup();
    const otherHook = await createHook(storage, runId, {
      hookId: 'hook_2',
      token: 'order:2',
    });
    const payload = new Uint8Array([1, 2, 3]);

    await resume(runId, hook, 'resume_1', 'digest_1', payload);

    // A second, distinct hook reuses the SAME (resumeId, digest). Only the
    // digest matches; the hook identity does not. Adopting the first hook's
    // event here would attribute this resume to the wrong hook — the converge
    // guard must reject on the hookId mismatch and commit no second event.
    await expect(
      resume(runId, otherHook, 'resume_1', 'digest_1', payload)
    ).rejects.toThrow();
    expect(await countHookReceived(runId)).toBe(1);
  });
});
