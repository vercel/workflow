import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForHook } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { resumeHook, start } from 'workflow/api';
import { inlineStepDuringHookResumeWorkflow } from '../workflows/inline-step-ownership.js';

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
