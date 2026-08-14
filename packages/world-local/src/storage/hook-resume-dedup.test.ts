import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_CURRENT, type Storage } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHook, createRun, disposeHook } from '../test-helpers.js';
import { hookResumeClaimPath } from './helpers.js';
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

  it('converges a committed resume re-ensured AFTER the hook was disposed', async () => {
    const { runId, hook } = await setup();
    const payload = new Uint8Array([1, 2, 3]);

    // Delivery 1: the consumer's re-ensure commits the resume while the
    // hook is alive.
    const first = await resume(runId, hook, 'resume_1', 'digest_1', payload);

    // The workflow receives the payload and disposes the hook (e.g. the
    // dispose → sleep pattern), releasing its token.
    await disposeHook(storage, runId, hook.hookId);

    // Delivery 2: the SAME message is redelivered (queue retry, or a
    // visibility-timeout continuation riding the resume message) and
    // re-ensures the same (resumeId, digest). The resume is already
    // committed — this must converge on the existing event as success, NOT
    // reject with HookNotFound. A rejection makes the consumer ack the
    // message as "nothing left to resume", silently dropping whatever
    // continuation it carried and wedging the run.
    const second = await resume(runId, hook, 'resume_1', 'digest_1', payload);

    expect(second.event.eventId).toBe(first.event.eventId);
    expect(await countHookReceived(runId)).toBe(1);

    // A genuinely NEW resume after disposal is still rejected.
    await expect(
      resume(runId, hook, 'resume_2', 'digest_2', new Uint8Array([9]))
    ).rejects.toThrow();
  });

  // A slot allocator is per storage instance, and two instances share the
  // directory whenever a dev server serves the hook request from one module
  // instance and runs the queue in another. The resume claim names the id its
  // writer MEANT to append at, drawn before the append, so a second instance
  // can publish an unrelated event at that position first.
  describe('when another instance takes the position the claim named', () => {
    async function seedStaleAllocator(runId: string) {
      // `other` scans the log once, then counts forward in memory. Writing
      // through `storage` afterwards fills the positions `other` still thinks
      // are free.
      const other = createStorage(testDir);
      const attr = (from: Storage, key: string) =>
        from.events.create(runId, {
          eventType: 'attr_set',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: `attr_${key}`,
          eventData: {
            changes: [{ key, value: 'x' }],
            writer: { type: 'workflow' },
          },
        });
      await attr(other, 'seed');
      await attr(storage, 'ahead_1');
      await attr(storage, 'ahead_2');
      return other;
    }

    it('still commits the resume, at the position actually free', async () => {
      const { runId, hook } = await setup();
      const other = await seedStaleAllocator(runId);
      const payload = new Uint8Array([1, 2, 3]);

      const result = await other.events.create(
        runId,
        {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hook.hookId,
          eventData: { token: hook.token, payload },
        },
        { resumeId: 'resume_1', resumePayloadDigest: 'digest_1' }
      );

      // The reported event must be this resume's own. Returning whatever sits
      // at the claimed position reports an `attr_set` as the resume's event
      // and drops the payload without an error.
      expect(result.event.eventType).toBe('hook_received');
      expect(result.event.resumeId).toBe('resume_1');
      expect(await countHookReceived(runId)).toBe(1);
    });

    it('converges the redelivery on the committed event, not on the occupant', async () => {
      const { runId, hook } = await setup();
      const other = await seedStaleAllocator(runId);
      const payload = new Uint8Array([1, 2, 3]);

      const first = await other.events.create(
        runId,
        {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hook.hookId,
          eventData: { token: hook.token, payload },
        },
        { resumeId: 'resume_1', resumePayloadDigest: 'digest_1' }
      );

      // Redelivery through the OTHER instance: it reads the claim, which named
      // a position the resume did not land at.
      const second = await resume(runId, hook, 'resume_1', 'digest_1', payload);

      expect(second.event.eventId).toBe(first.event.eventId);
      expect(await countHookReceived(runId)).toBe(1);
    });

    it('converges a redelivery whose claim still names the occupied position', async () => {
      const { runId, hook } = await setup();
      const other = await seedStaleAllocator(runId);
      const payload = new Uint8Array([1, 2, 3]);

      const first = await other.events.create(
        runId,
        {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hook.hookId,
          eventData: { token: hook.token, payload },
        },
        { resumeId: 'resume_1', resumePayloadDigest: 'digest_1' }
      );

      // Roll the claim back to the position it named before the append, as a
      // crash between the append and the claim's correction would leave it.
      // That position holds an unrelated event, so a reader that trusts the
      // claim reports an `attr_set` as this resume's event: no error, no
      // second event, and the payload silently gone.
      const claimPath = hookResumeClaimPath(testDir, runId, 'resume_1');
      const claim = JSON.parse(await fs.readFile(claimPath, 'utf8'));
      const occupant = (await storage.events.list({ runId })).data.find(
        (event) => event.eventType === 'attr_set'
      );
      await fs.writeFile(
        claimPath,
        JSON.stringify({ ...claim, eventId: occupant?.eventId })
      );

      const second = await resume(runId, hook, 'resume_1', 'digest_1', payload);

      expect(second.event.eventType).toBe('hook_received');
      expect(second.event.eventId).toBe(first.event.eventId);
      expect(await countHookReceived(runId)).toBe(1);
    });
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
