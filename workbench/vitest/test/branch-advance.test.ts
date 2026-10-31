import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForHook } from '@workflow/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeHook, start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import {
  chainIntoHookWorkflow,
  hookVsStepWorkflow,
  leafFanOutWorkflow,
  parallelChainsWorkflow,
  raceLoserRetriesWorkflow,
  raceLoserThenThrowWorkflow,
  raceLoserWorkflow,
  retryBesideSleepWorkflow,
  retryBesideSlowWorkflow,
  sleepTimeoutWorkflow,
} from '../workflows/branch-advance.js';

const FAST_MS = 200;
const SLOW_MS = 2000;

/**
 * The QuickJS engine has its own inline loop, which still waits for the
 * whole batch, so the early-advance timing assertions only hold on node:vm.
 */
const lockstepEngine = process.env.WORKFLOW_VM === 'quickjs';

async function markerFile() {
  const dir = await mkdtemp(join(tmpdir(), 'wf-4457-'));
  return join(dir, 'marker.log');
}

/** How many times each step body was entered. */
async function bodyEntries(markerPath: string) {
  const counts: Record<string, number> = {};
  for (const name of (await readFile(markerPath, 'utf8'))
    .split('\n')
    .filter(Boolean)) {
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/**
 * The run's events once its terminal event is listed. `returnValue` can
 * settle off the run row a moment before the event is.
 */
async function eventsThroughTerminal(runId: string, terminalType: string) {
  const world = await getWorld();
  return await vi.waitFor(
    async () => {
      const { data } = await world.events.list({ runId, resolveData: 'none' });
      const types = data.map((e) => e.eventType);
      if (!types.includes(terminalType as (typeof types)[number])) {
        throw new Error(`no ${terminalType} yet`);
      }
      return types;
    },
    { timeout: 5_000 }
  );
}

/** How many steps completed before the run's terminal event. */
async function stepsCompletedBeforeTerminal(
  runId: string,
  terminalType: string
) {
  const types = await eventsThroughTerminal(runId, terminalType);
  return types
    .slice(0, types.indexOf(terminalType as (typeof types)[number]))
    .filter((t) => t === 'step_completed').length;
}

afterEach(() => {
  delete process.env.WORKFLOW_INLINE_EARLY_ADVANCE;
  delete process.env.WORKFLOW_REPLAY_TIMEOUT_MS;
  delete process.env.WORKFLOW_REPLAY_TIMEOUT_MAX_RETRIES;
});

describe('parallel branches advance independently (#4457)', () => {
  it.skipIf(lockstepEngine)(
    'a fast chain finishes while its slow sibling is still on its first step',
    async () => {
      const markerPath = await markerFile();
      const run = await start(parallelChainsWorkflow, [
        [
          { prefix: 'fast', ms: FAST_MS, length: 3 },
          { prefix: 'slow', ms: SLOW_MS, length: 2 },
        ],
        markerPath,
      ]);
      const [fast, slow] = await run.returnValue;

      expect(fast[2].end).toBeLessThan(slow[0].end);
      // The second fast step did not wait for the slow step to end.
      expect(fast[1].start).toBeLessThan(slow[0].end);
      expect(Object.values(await bodyEntries(markerPath))).toEqual(
        Array(5).fill(1)
      );
    },
    60_000
  );

  it.skipIf(lockstepEngine)(
    'advances three chains (the default inline limit) independently',
    async () => {
      const markerPath = await markerFile();
      const run = await start(parallelChainsWorkflow, [
        [
          { prefix: 'a', ms: FAST_MS, length: 3 },
          { prefix: 'b', ms: FAST_MS * 2, length: 2 },
          { prefix: 'c', ms: SLOW_MS, length: 1 },
        ],
        markerPath,
      ]);
      const [a, b, c] = await run.returnValue;
      expect(a[2].end).toBeLessThan(c[0].end);
      expect(b[1].end).toBeLessThan(c[0].end);
      expect(Object.values(await bodyEntries(markerPath))).toEqual(
        Array(6).fill(1)
      );
    },
    60_000
  );

  it('runs in lockstep with WORKFLOW_INLINE_EARLY_ADVANCE=0', async () => {
    process.env.WORKFLOW_INLINE_EARLY_ADVANCE = '0';
    const markerPath = await markerFile();
    const run = await start(parallelChainsWorkflow, [
      [
        { prefix: 'fast', ms: FAST_MS, length: 2 },
        { prefix: 'slow', ms: SLOW_MS, length: 1 },
      ],
      markerPath,
    ]);
    const [fast, slow] = await run.returnValue;
    expect(fast[1].start).toBeGreaterThanOrEqual(slow[0].end);
  }, 60_000);

  it.skipIf(lockstepEngine)(
    'completes a race without waiting for the loser, which still runs once',
    async () => {
      const markerPath = await markerFile();
      const started = Date.now();
      const run = await start(raceLoserWorkflow, [
        FAST_MS,
        SLOW_MS,
        markerPath,
      ]);
      await expect(run.returnValue).resolves.toBe('fast');
      expect(Date.now() - started).toBeLessThan(SLOW_MS);
      expect(
        await stepsCompletedBeforeTerminal(run.runId, 'run_completed')
      ).toBe(1);

      // The loser's body is not cut off or re-run after the run ended.
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
      expect(await bodyEntries(markerPath)).toEqual({ fast: 1, slow: 1 });
    },
    60_000
  );

  it.skipIf(lockstepEngine)(
    'fails a run without waiting for the loser, which still runs once',
    async () => {
      const markerPath = await markerFile();
      const started = Date.now();
      const run = await start(raceLoserThenThrowWorkflow, [
        FAST_MS,
        SLOW_MS,
        markerPath,
      ]);
      await expect(run.returnValue).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(SLOW_MS);
      expect(await stepsCompletedBeforeTerminal(run.runId, 'run_failed')).toBe(
        1
      );

      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
      expect(await bodyEntries(markerPath)).toEqual({ fast: 1, slow: 1 });
    },
    60_000
  );

  // Pins the current behavior. With early advance on, the run ends over the
  // loser, so its retry is never attempted (the World refuses a step start on
  // a terminal run) and the step is left pending after the terminal event.
  // With it off, node:vm waits for the loser to retry and complete; the
  // QuickJS loop waits for its first attempt only, then ends the run with the
  // step still pending.
  for (const earlyAdvance of ['1', '0']) {
    it.skipIf(lockstepEngine && earlyAdvance === '1')(
      `a race loser that retries after the run ended (early advance ${earlyAdvance})`,
      async () => {
        process.env.WORKFLOW_INLINE_EARLY_ADVANCE = earlyAdvance;
        const markerPath = await markerFile();
        const run = await start(raceLoserRetriesWorkflow, [
          FAST_MS,
          FAST_MS * 4,
          markerPath,
        ]);
        await expect(run.returnValue).resolves.toBe('fast');
        // Past the loser's first attempt and its 100ms retryAfter.
        await new Promise((resolve) => setTimeout(resolve, FAST_MS * 10));

        const types = await eventsThroughTerminal(run.runId, 'run_completed');
        const world = await getWorld();
        const { data: steps } = await world.steps.list({
          runId: run.runId,
          resolveData: 'none',
        });
        const slow = steps.find((s) => s.stepName.endsWith('retryOnceStep'));
        if (earlyAdvance === '1') {
          expect(types.slice(types.indexOf('run_completed') + 1)).toEqual([
            'step_retrying',
          ]);
          expect(slow?.status).toBe('pending');
          expect(await bodyEntries(markerPath)).toEqual({ fast: 1, slow: 1 });
        } else if (lockstepEngine) {
          expect(types.slice(-2)).toEqual(['step_retrying', 'run_completed']);
          expect(slow?.status).toBe('pending');
          expect(await bodyEntries(markerPath)).toEqual({ fast: 1, slow: 1 });
        } else {
          expect(types.at(-1)).toBe('run_completed');
          expect(slow?.status).toBe('completed');
          expect(await bodyEntries(markerPath)).toEqual({ fast: 1, slow: 2 });
        }
      },
      60_000
    );
  }

  it('registers a hook in one branch while the other branch is still running a step', async () => {
    const markerPath = await markerFile();
    const token = `branch-advance-${Math.random().toString(36).slice(2)}`;
    const run = await start(chainIntoHookWorkflow, [
      token,
      FAST_MS,
      SLOW_MS,
      markerPath,
    ]);
    await waitForHook(run, { token });
    const resumedAt = Date.now();
    await resumeHook(token, { n: 7 });
    const result = await run.returnValue;

    expect(result.n).toBe(7);
    // The hook was reachable before the slow step ended.
    if (!lockstepEngine) expect(resumedAt).toBeLessThan(result.slow.end);
    expect(await bodyEntries(markerPath)).toEqual({
      fast1: 1,
      fast2: 1,
      slow: 1,
    });
  }, 60_000);

  it('retries a step beside a slow sibling and runs every body the expected number of times', async () => {
    const markerPath = await markerFile();
    const run = await start(retryBesideSlowWorkflow, [
      FAST_MS,
      SLOW_MS,
      markerPath,
    ]);
    const [[flaky, after], slow] = await run.returnValue;
    expect(flaky.name).toBe('flaky');
    expect(after.name).toBe('after-flaky');
    expect(slow.name).toBe('slow');
    expect(await bodyEntries(markerPath)).toEqual({
      flaky: 2,
      'after-flaky': 1,
      slow: 1,
    });
  }, 60_000);

  it('does not charge a race loser to the replay budget', async () => {
    // The smallest budget the runtime accepts, and no retry to hide behind:
    // a loser that outlives it must not fail the run.
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '30000';
    process.env.WORKFLOW_REPLAY_TIMEOUT_MAX_RETRIES = '0';
    const markerPath = await markerFile();
    const run = await start(raceLoserWorkflow, [FAST_MS, 33_000, markerPath]);
    await expect(run.returnValue).resolves.toBe('fast');
    expect(await bodyEntries(markerPath)).toEqual({ fast: 1, slow: 1 });
  }, 90_000);

  for (const earlyAdvance of ['1', '0']) {
    it(`ends a race won by a sleep without waiting for the losing step (early advance ${earlyAdvance})`, async () => {
      process.env.WORKFLOW_INLINE_EARLY_ADVANCE = earlyAdvance;
      const startedAt = Date.now();
      const run = await start(sleepTimeoutWorkflow, [8_000]);
      await expect(run.returnValue).resolves.toBe('timeout');
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    }, 60_000);

    it(`ends a race won by a hook without waiting for the losing step (early advance ${earlyAdvance})`, async () => {
      process.env.WORKFLOW_INLINE_EARLY_ADVANCE = earlyAdvance;
      const token = `branch-advance-${Math.random().toString(36).slice(2)}`;
      const run = await start(hookVsStepWorkflow, [token, 8_000]);
      await waitForHook(run, { token });
      const resumedAt = Date.now();
      await resumeHook(token, { v: 'hook' });
      await expect(run.returnValue).resolves.toBe('hook');
      expect(Date.now() - resumedAt).toBeLessThan(5_000);
    }, 60_000);
  }

  it.skipIf(lockstepEngine)(
    "keeps a running sibling's retry backoff when a stale write re-invokes the run",
    async () => {
      // The early pass that reaches the sleep has its `wait_created` refused
      // as stale once, with no in-process restart left, so the delivery
      // re-invokes while the sibling's first attempt is still running. That
      // attempt fails with a plain error, whose 1s backoff only the delayed
      // retry message enforces.
      process.env.WORKFLOW_PRECONDITION_MAX_INPROCESS_RESTARTS = '0';
      process.env.WORKFLOW_PRECONDITION_REINVOKE_DELAY_SECONDS = '0';
      const world = await getWorld();
      const originalCreate = world.events.create;
      let refused = 0;
      world.events.create = (async (
        ...args: Parameters<typeof originalCreate>
      ) => {
        if (args[1].eventType === 'wait_created' && refused === 0) {
          refused++;
          const err = new Error('stale snapshot (injected)');
          err.name = 'PreconditionFailedError';
          throw err;
        }
        return originalCreate.apply(world.events, args);
      }) as typeof originalCreate;
      try {
        const markerPath = await markerFile();
        const run = await start(retryBesideSleepWorkflow, [
          FAST_MS,
          FAST_MS * 3,
          markerPath,
        ]);
        await expect(run.returnValue).resolves.toEqual(['slept', 2]);
        expect(refused).toBe(1);

        const attempts = (await readFile(markerPath, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
        // The default backoff after a plain error is 1s; allow for timer
        // and clock slack, well above an immediate re-dispatch.
        expect(attempts[1].start - attempts[0].end).toBeGreaterThan(800);
      } finally {
        world.events.create = originalCreate;
        delete process.env.WORKFLOW_PRECONDITION_MAX_INPROCESS_RESTARTS;
        delete process.env.WORKFLOW_PRECONDITION_REINVOKE_DELAY_SECONDS;
      }
    },
    60_000
  );

  it('completes a leaf fan-out wider than the inline limit', async () => {
    const markerPath = await markerFile();
    const widths = [FAST_MS, FAST_MS * 2, FAST_MS * 3, FAST_MS, FAST_MS * 2];
    const run = await start(leafFanOutWorkflow, [widths, markerPath]);
    const spans = await run.returnValue;
    expect(spans.map((s) => s.name)).toEqual(widths.map((_, i) => `leaf${i}`));
    expect(Object.values(await bodyEntries(markerPath))).toEqual(
      Array(widths.length).fill(1)
    );
  }, 60_000);
});
