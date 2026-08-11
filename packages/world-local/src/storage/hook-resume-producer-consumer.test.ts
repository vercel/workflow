import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HookNotFoundError, RunExpiredError } from '@workflow/errors';
import {
  type EventResult,
  SPEC_VERSION_CURRENT,
  type Storage,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHook, createRun, updateRun } from '../test-helpers.js';
import { createStorage } from './index.js';

// End-to-end coverage of the lazy hook resume's TWO writers against the
// world-local backend (the dev World that advertises `hookResumeDedup`).
//
// On the parallel fast path, `resumeHook()` (the PRODUCER) writes the
// `hook_received` event directly AND publishes a queue message carrying the
// same `resumeId`; the queue consumer's re-ensure (the CONSUMER) writes the
// same `hook_received` again before replay. Whichever lands first, the backend
// must converge both onto exactly ONE committed event so replay never sees a
// duplicated resume — the same guarantee the Vercel server enforces with its
// `(runId, resumeId)` constraint.
//
// These tests drive `storage.events.create` with the exact arguments the real
// producer (packages/core/src/runtime/resume-hook.ts) and consumer
// (packages/core/src/runtime.ts) pass, so they exercise the convergence,
// ordering, concurrency, and terminal-run behavior that the mocked core unit
// tests (resume-hook.parallel.test.ts) cannot.
describe('world-local lazy hook resume: producer/consumer convergence', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-resume-pc-'));
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

  // One "writer" of a resume — used for both the producer's direct write and
  // the consumer's re-ensure. They are byte-for-byte identical calls (same
  // resumeId, digest, and payload), which is exactly what makes them converge.
  function write(
    runId: string,
    hook: { hookId: string; token: string },
    resumeId: string,
    payloadDigest: string,
    payload: Uint8Array
  ): Promise<EventResult> {
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

  it('producer-wins: the direct write commits first; the consumer re-ensure adopts it', async () => {
    const { runId, hook } = await setup();
    const payload = new Uint8Array([1, 2, 3]);

    const producer = await write(runId, hook, 'r_1', 'd_1', payload);
    const consumer = await write(runId, hook, 'r_1', 'd_1', payload);

    expect(consumer.event.eventId).toBe(producer.event.eventId);
    expect(await countHookReceived(runId)).toBe(1);
  });

  it('consumer-wins: the re-ensure commits first (producer write lost/delayed), then converges on redelivery', async () => {
    const { runId, hook } = await setup();
    const payload = new Uint8Array([4, 5, 6]);

    // The direct producer write never lands (e.g. a 5xx that resumeHook
    // swallows). The consumer re-ensure is the first writer to commit.
    const consumer = await write(runId, hook, 'r_2', 'd_2', payload);
    // At-least-once queue delivery: the consumer runs again for the same
    // message and re-ensures once more — it must return the same event.
    const redelivery = await write(runId, hook, 'r_2', 'd_2', payload);
    // A late producer write finally lands; it too converges.
    const lateProducer = await write(runId, hook, 'r_2', 'd_2', payload);

    expect(redelivery.event.eventId).toBe(consumer.event.eventId);
    expect(lateProducer.event.eventId).toBe(consumer.event.eventId);
    expect(await countHookReceived(runId)).toBe(1);
  });

  it('concurrent race: producer and consumer fire simultaneously and still commit exactly one event', async () => {
    const { runId, hook } = await setup();
    const payload = new Uint8Array([7, 8, 9]);

    const [a, b] = await Promise.all([
      write(runId, hook, 'r_3', 'd_3', payload),
      write(runId, hook, 'r_3', 'd_3', payload),
    ]);

    expect(a.event.eventId).toBe(b.event.eventId);
    expect(await countHookReceived(runId)).toBe(1);
  });

  it('distinct resumes of a reusable hook each commit their own event under load', async () => {
    const { runId, hook } = await setup();

    // A reusable hook (AsyncIterable) receives many resumes under one hookId.
    // Each resume has its own resumeId and BOTH its writers must converge only
    // with each other — never across resumes.
    const resumes = Array.from({ length: 5 }, (_, i) => ({
      resumeId: `r_multi_${i}`,
      digest: `d_multi_${i}`,
      payload: new Uint8Array([i]),
    }));

    const results = await Promise.all(
      resumes.flatMap(({ resumeId, digest, payload }) => [
        write(runId, hook, resumeId, digest, payload), // producer
        write(runId, hook, resumeId, digest, payload), // consumer re-ensure
      ])
    );

    // Each resume's two writers share an eventId; the five resumes are distinct.
    const uniqueEventIds = new Set(results.map((r) => r.event.eventId));
    expect(uniqueEventIds.size).toBe(resumes.length);
    expect(await countHookReceived(runId)).toBe(resumes.length);
  });

  it('terminal rejection: a resume against an already-completed run is rejected and writes no event', async () => {
    const { runId, hook } = await setup();
    await updateRun(storage, runId, 'run_completed', {
      output: new Uint8Array(),
    });

    // The run genuinely ended before the resume. Both the producer's direct
    // write and the consumer's re-ensure reject against the terminal run with a
    // "hook gone" error: completing the run disposes the hook, so the disposal
    // guard rejects with HookNotFoundError (a resume that raced the disposal
    // instead hits the terminal-run guard and gets RunExpiredError). resumeHook
    // re-keys either to HookNotFoundError(token); the consumer's re-ensure
    // no-ops the same way — so no hook_received is ever committed.
    await expect(
      write(runId, hook, 'r_term', 'd_term', new Uint8Array([1]))
    ).rejects.toSatisfy(
      (e: unknown) => HookNotFoundError.is(e) || RunExpiredError.is(e)
    );

    expect(await countHookReceived(runId)).toBe(0);
  });
});
