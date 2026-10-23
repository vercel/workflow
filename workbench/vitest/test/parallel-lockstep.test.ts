import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import {
  parallelLockstepSlowFirstWorkflow,
  parallelLockstepWorkflow,
} from '../workflows/parallel-lockstep.js';

const FAST_MS = 200;
const SLOW_MS = 3000;
/** What the fast branch costs when each of its steps waits for a slow one. */
const LOCKSTEP_MS = 2 * SLOW_MS + FAST_MS;

type Marker = { label: string; phase: 'start' | 'end'; at: number };

function parseMarkers(contents: string): Marker[] {
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [label, phase, at] = line.split(' ');
      return { label, phase: phase as 'start' | 'end', at: Number(at) };
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * Runs one fan-out shape and asserts the fast branch finished on its own
 * schedule rather than its slow sibling's. `tag` labels the printed timeline.
 */
async function expectFastBranchNotGated(
  workflow:
    | typeof parallelLockstepWorkflow
    | typeof parallelLockstepSlowFirstWorkflow,
  tag: string
) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-4457-'));
  const markerPath = join(dir, 'timeline.log');

  const run = await start(workflow, [markerPath, FAST_MS, SLOW_MS]);
  await expect(run.returnValue).resolves.toBe('done');

  const markers = parseMarkers(await readFile(markerPath, 'utf8'));
  const t0 = markers[0].at;
  const at = (label: string, phase: 'start' | 'end') => {
    const marker = markers.find((m) => m.label === label && m.phase === phase);
    if (!marker) throw new Error(`missing marker ${label} ${phase}`);
    return marker.at - t0;
  };

  const timeline = `[${tag}] timeline (ms from first step body):\n${markers
    .map((m) => `  +${String(m.at - t0).padStart(6)}  ${m.label} ${m.phase}`)
    .join('\n')}`;

  const fastBranchDuration = at('fast3', 'end');

  // The fast branch's own work is 3 * FAST_MS. Allow generous slack for the
  // per-step grace delay and replay, but stay far below the lockstep cost.
  // The message carries the timeline, so a failure reads without a re-run.
  expect(
    fastBranchDuration,
    `the fast branch took ${fastBranchDuration}ms; its own work is ${
      3 * FAST_MS
    }ms and the lockstep cost would be ~${LOCKSTEP_MS}ms\n${timeline}`
  ).toBeLessThan(LOCKSTEP_MS / 2);

  // The sharpest signal: fast2 must not wait for slow1 to end.
  expect(
    at('fast2', 'start'),
    `fast2 started only after slow1 ended\n${timeline}`
  ).toBeLessThan(at('slow1', 'end'));
}

// The QuickJS engine (WORKFLOW_VM=quickjs) runs its own replay loop, which
// does not advance branches independently yet: its branches still advance in
// lockstep.
describe.skipIf(process.env.WORKFLOW_VM === 'quickjs')(
  'parallel branch lockstep (#4457)',
  () => {
    // Issue #4457: branches of a `Promise.all` used to advance in lockstep. A
    // branch whose step ended could not start its next step until every other
    // step pending in the same batch had ended, so each round of the fan-out
    // cost as long as its slowest step.
    //
    // The fast branch here is three ~200ms steps, so it should finish well
    // before the slow branch's second step does: its own work, plus the grace
    // delay a settled branch gives its siblings before advancing alone
    // (WORKFLOW_EAGER_BRANCH_REPLAY_DELAY_MS, 250ms), plus a replay per step.
    // Under lockstep it finishes at ~2 * SLOW_MS + FAST_MS instead, because
    // `fast2` is only created when `slow1` ends and `fast3` when `slow2` ends.
    it('a fast branch does not wait for its slow sibling between steps', async () => {
      await expectFastBranchNotGated(parallelLockstepWorkflow, 'fast-first');
    }, 120_000);

    // Same shape with the branches swapped. Under the default inline-step cap
    // both cases go through the inline path (every branch's step runs inline in
    // one invocation). Under `WORKFLOW_MAX_INLINE_STEPS=1` they split: whichever
    // branch wins the single inline slot runs inline, and the other runs as a
    // queued step, so the pair covers both paths.
    it('a fast branch listed after a slow one is not gated either', async () => {
      await expectFastBranchNotGated(
        parallelLockstepSlowFirstWorkflow,
        'slow-first'
      );
    }, 120_000);
  }
);
