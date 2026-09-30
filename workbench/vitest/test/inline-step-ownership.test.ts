import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForHook } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { resumeHook, start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import {
  inlineStepDuringHookResumeWorkflow,
  inlineStepDuringRedeliveryWorkflow,
} from '../workflows/inline-step-ownership.js';

describe('inline step ownership (#2780)', () => {
  // Issue #2780: an inline step has no queue message of its own, so a wake
  // that replays the run mid-step (here: a hook resume) used to enqueue a
  // *first* message for it; that message's handler bare-started the still-
  // running step and executed the body a second time, concurrently. With
  // inline ownership, the lazy step_started records the owning queue message
  // ID and the wake replay only ensures a delayed backstop — the side effect
  // must fire exactly once.
  it('a hook resume mid-inline-step does not re-execute the step body', async () => {
    const token = `inline-ownership-${Math.random().toString(36).slice(2)}`;
    const dir = await mkdtemp(join(tmpdir(), 'wf-2780-'));
    const markerPath = join(dir, 'marker.log');

    const run = await start(inlineStepDuringHookResumeWorkflow, [
      token,
      markerPath,
    ]);

    // The hook and the step suspend together; the hook is durably registered
    // just before the step body starts executing inline. Waiting for the
    // hook then pausing briefly lands the resume squarely mid-body (~400ms
    // into a ~1500ms step).
    await waitForHook(run, { token });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await resumeHook(token, { n: 1 });

    await expect(run.returnValue).resolves.toBe('done');

    const marker = await readFile(markerPath, 'utf8');
    const executions = marker.split('\n').filter(Boolean);
    expect(
      executions,
      'the inline step body must execute exactly once despite the mid-step wake'
    ).toHaveLength(1);
  }, 60_000);
});

describe('inline step redelivery (#3909)', () => {
  // Issue #3909: world-local's queue used to give up on a delivery after 30s
  // and redeliver the same message while its handler was still running a
  // lazy inline step. The redelivery re-entered turbo (attempt 1), skipped the
  // event log, and ran the step body again concurrently. Simulate that
  // redelivery by re-sending the run's start message mid-body: the in-process
  // single-flight must absorb it so the body is entered exactly once.
  it('a redelivered start message mid-inline-step does not re-execute the step body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-3909-'));
    const markerPath = join(dir, 'marker.log');

    const world = await getWorld();
    const originalQueue = world.queue;
    const redelivered: Promise<unknown>[] = [];
    world.queue = async (queueName, message, opts) => {
      const result = await originalQueue.call(world, queueName, message, opts);
      if (
        redelivered.length === 0 &&
        queueName.startsWith('__wkf_workflow_') &&
        (message as { runInput?: unknown }).runInput !== undefined
      ) {
        redelivered.push(
          new Promise((resolve) => setTimeout(resolve, 500)).then(() =>
            originalQueue.call(world, queueName, message, opts)
          )
        );
      }
      return result;
    };

    try {
      const run = await start(inlineStepDuringRedeliveryWorkflow, [markerPath]);
      await expect(run.returnValue).resolves.toBe('done');
      expect(redelivered).toHaveLength(1);
      await Promise.all(redelivered);
    } finally {
      world.queue = originalQueue;
    }

    const marker = await readFile(markerPath, 'utf8');
    const executions = marker.split('\n').filter(Boolean);
    expect(
      executions,
      'the inline step body must execute exactly once despite the redelivery'
    ).toHaveLength(1);
  }, 60_000);
});
