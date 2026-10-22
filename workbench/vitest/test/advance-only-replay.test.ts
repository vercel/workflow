import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import {
  caughtSlowPromiseChain,
  chainedFanoutBenchmark,
  detachedAfterAdvanceOnlyReplay,
  detachedStep,
  duplicateProbe,
  failAfterRaceLoser,
  fastFirstParallelChains,
  oneStepFanoutBenchmark,
  queuedRaceLoserWithDetachedTerminalDrain,
  raceLoser,
  raceThenNext,
  retryingRaceLoserWithDetachedTerminalDrain,
  slowFirstParallelChains,
  threeParallelChains,
  twoDifferentLeafBenchmark,
  twoDifferentLeafDurations,
  twoLeafBenchmark,
  twoLeafPromiseAll,
  workflowStartedAtAcrossBackgroundReplay,
} from '../workflows/advance-only-replay.js';

const FAST_MS = 200;
const SLOW_MS = 3_000;
const SHORT_MS = 100;

type Marker = {
  label: string;
  phase: 'start' | 'end' | 'return';
  at: number;
};

function parseMarkers(contents: string): Marker[] {
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [label, phase, at] = line.split(' ');
      return { label, phase: phase as Marker['phase'], at: Number(at) };
    })
    .sort((a, b) => a.at - b.at);
}

function formatTimeline(tag: string, markers: Marker[]): string {
  const t0 = markers[0]?.at ?? 0;
  return `[${tag}] timeline (ms from first step start):\n${markers
    .map(
      (marker) =>
        `  +${String(marker.at - t0).padStart(6)}  ${marker.label} ${marker.phase}`
    )
    .join('\n')}`;
}

function markerAt(
  markers: Marker[],
  label: string,
  phase: Marker['phase']
): number {
  const marker = markers.find(
    (candidate) => candidate.label === label && candidate.phase === phase
  );
  if (!marker) throw new Error(`Missing marker: ${label} ${phase}`);
  return marker.at;
}

async function runWithTimeline(
  workflow:
    | typeof fastFirstParallelChains
    | typeof slowFirstParallelChains
    | typeof caughtSlowPromiseChain
    | typeof twoLeafPromiseAll
    | typeof raceThenNext
    | typeof threeParallelChains
    | typeof twoDifferentLeafDurations
    | typeof detachedAfterAdvanceOnlyReplay
    | typeof detachedStep
    | typeof raceLoser
    | typeof duplicateProbe,
  args: number[],
  tag: string
): Promise<{ markers: Marker[]; timeline: string; wallMs: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-4457-'));
  const markerPath = join(dir, 'timeline.log');
  try {
    const wallStart = performance.now();
    const run = await start(workflow, [markerPath, ...args] as never);
    await run.returnValue;
    const wallMs = performance.now() - wallStart;
    const markers = parseMarkers(await readFile(markerPath, 'utf8'));
    return { markers, timeline: formatTimeline(tag, markers), wallMs };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runDetachedAfterAdvanceOnlyReplay(
  tag: string,
  observeAfterReturnMs = 0
): Promise<{
  markers: Marker[];
  timeline: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-4457-detached-'));
  const markerPath = join(dir, 'timeline.log');
  try {
    const run = await start(detachedAfterAdvanceOnlyReplay, [
      markerPath,
      100,
      1_500,
      600,
    ]);
    await run.returnValue;
    const returnedAt = Date.now();
    if (observeAfterReturnMs > 0) {
      // Observe a detached body that may still be running after the workflow
      // returns. This wait is outside workflow execution and does not affect
      // the ordering under test.
      await new Promise((resolve) => setTimeout(resolve, observeAfterReturnMs));
    }
    const markers = [
      ...parseMarkers(await readFile(markerPath, 'utf8')),
      { label: 'workflow', phase: 'return' as const, at: returnedAt },
    ].sort((a, b) => a.at - b.at);
    return { markers, timeline: formatTimeline(tag, markers) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function terminalDrainRaceCompletes(
  workflow:
    | typeof retryingRaceLoserWithDetachedTerminalDrain
    | typeof queuedRaceLoserWithDetachedTerminalDrain,
  tag: string,
  maxInlineSteps?: string
): Promise<{ completed: boolean; events: string; wallMs: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-4457-terminal-drain-'));
  const markerPath = join(dir, `${tag}.log`);
  const originalMaxInlineSteps = process.env.WORKFLOW_MAX_INLINE_STEPS;
  if (maxInlineSteps === undefined) {
    delete process.env.WORKFLOW_MAX_INLINE_STEPS;
  } else {
    process.env.WORKFLOW_MAX_INLINE_STEPS = maxInlineSteps;
  }
  try {
    const wallStart = performance.now();
    const run = await start(workflow, [markerPath]);
    const completed = await Promise.race([
      run.returnValue.then(
        () => true,
        () => false
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000)),
    ]);
    let events = '';
    if (!completed) {
      const world = await getWorld();
      const eventPage = await world.events.list({ runId: run.runId });
      events = eventPage.data
        .map((event) =>
          event.eventType === 'step_created'
            ? `${event.eventType}:${event.correlationId}:${event.eventData.terminalDrain === true ? 'terminal-drain' : 'scheduled'}`
            : `${event.eventType}:${event.correlationId ?? ''}`
        )
        .join(', ');
    }
    if (!completed) await run.cancel({ cancelReason: 'repro timeout' });
    return {
      completed,
      events,
      wallMs: Math.round(performance.now() - wallStart),
    };
  } finally {
    if (originalMaxInlineSteps === undefined) {
      delete process.env.WORKFLOW_MAX_INLINE_STEPS;
    } else {
      process.env.WORKFLOW_MAX_INLINE_STEPS = originalMaxInlineSteps;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.WORKFLOW_VM === 'quickjs')(
  'advance-only replay (#4457)',
  () => {
    it.each([
      ['fast-first', fastFirstParallelChains],
      ['slow-first', slowFirstParallelChains],
    ] as const)(
      'Shape A: advances a fast chain independently (%s)',
      async (tag, workflow) => {
        const { markers, timeline } = await runWithTimeline(
          workflow,
          [FAST_MS, SLOW_MS],
          tag
        );
        const firstStart = markers[0].at;
        const fastDuration = markerAt(markers, 'fast3', 'end') - firstStart;

        expect(
          markerAt(markers, 'fast2', 'start'),
          `fast2 did not start before slow1 ended\n${timeline}`
        ).toBeLessThan(markerAt(markers, 'slow1', 'end'));
        expect(
          fastDuration,
          `fast chain finished in ${fastDuration}ms, expected under 3100ms\n${timeline}`
        ).toBeLessThan(3_100);
      },
      30_000
    );

    it('Shape B: advances after the awaited short step', async () => {
      for (const slowMs of [300, 600, 1_500]) {
        const tag = `slow-${slowMs}`;
        const { markers, timeline } = await runWithTimeline(
          caughtSlowPromiseChain,
          [slowMs, SHORT_MS],
          tag
        );
        const gap =
          markerAt(markers, 'next', 'start') -
          markerAt(markers, 'short', 'end');
        expect
          .soft(
            gap,
            `next started ${gap}ms after short ended, expected within 300ms\n${timeline}`
          )
          .toBeLessThanOrEqual(300);
      }
    });

    it.each([
      ['no-op', 0, 300],
      ['200 ms', 200, 500],
    ] as const)('keeps a two-step Promise.all on the inline timing path (%s)', async (tag, delayMs, maxWallMs) => {
      const { markers, timeline, wallMs } = await runWithTimeline(
        twoLeafPromiseAll,
        [delayMs, 0],
        `two-leaf-${tag}`
      );
      expect(
        wallMs,
        `two-leaf workflow took ${Math.round(wallMs)}ms\n${timeline}`
      ).toBeLessThan(maxWallMs);
      expect(
        Math.abs(
          markerAt(markers, 'leaf1', 'start') -
            markerAt(markers, 'leaf2', 'start')
        ),
        timeline
      ).toBeLessThan(100);
    });

    it('finishes both unequal leaf steps before returning', async () => {
      const { markers, timeline } = await runWithTimeline(
        twoDifferentLeafDurations,
        [200, 800],
        'two-leaf-200-800'
      );
      expect(
        markerAt(markers, 'different-leaf-2', 'end'),
        timeline
      ).toBeGreaterThan(markerAt(markers, 'different-leaf-1', 'end'));
    });

    it('advances after a Promise.race winner without waiting for the loser', async () => {
      const { markers, timeline } = await runWithTimeline(
        raceThenNext,
        [200, 2_000],
        'race-then-next'
      );
      const gap =
        markerAt(markers, 'race-next', 'start') -
        markerAt(markers, 'race-fast', 'end');
      expect(
        gap,
        `race continuation gap was ${gap}ms\n${timeline}`
      ).toBeLessThanOrEqual(150);
    });

    it('keeps three chains in lockstep at the default pending limit', async () => {
      const { markers, timeline } = await runWithTimeline(
        threeParallelChains,
        [100, 500],
        'three-chains-default'
      );
      const fast2 = markerAt(markers, 'three-fast-2', 'start');
      expect(fast2, timeline).toBeGreaterThanOrEqual(
        markerAt(markers, 'three-slow-a-1', 'end')
      );
      expect(fast2, timeline).toBeGreaterThanOrEqual(
        markerAt(markers, 'three-slow-b-1', 'end')
      );
    });

    it('advances three chains through the hand-off path when the pending limit is 2', async () => {
      const original = process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING;
      process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING = '2';
      try {
        const { markers, timeline } = await runWithTimeline(
          threeParallelChains,
          [100, 500],
          'three-chains-limit-2'
        );
        const fast2 = markerAt(markers, 'three-fast-2', 'start');
        expect(fast2, timeline).toBeLessThan(
          markerAt(markers, 'three-slow-a-1', 'end')
        );
        expect(fast2, timeline).toBeLessThan(
          markerAt(markers, 'three-slow-b-1', 'end')
        );
      } finally {
        if (original === undefined) {
          delete process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING;
        } else {
          process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING = original;
        }
      }
    });

    it.each([
      ['detached step', detachedStep, 'detached'],
      ['Promise.race loser', raceLoser, 'race-loser'],
    ] as const)('lets a %s finish before the run returns', async (tag, workflow, label) => {
      const { markers, timeline } = await runWithTimeline(
        workflow,
        [150, 0],
        tag
      );
      expect(markerAt(markers, label, 'end'), timeline).toBeGreaterThanOrEqual(
        markerAt(markers, label, 'start')
      );
    });

    it('does not seal the run while a step started by an advance-only replay is running', async () => {
      for (let run = 0; run < 5; run++) {
        const { markers, timeline } = await runDetachedAfterAdvanceOnlyReplay(
          `detached-race-${run}`
        );
        expect(markerAt(markers, 'detached-race-d', 'start'), timeline).toBe(
          markerAt(markers, 'detached-race-d', 'start')
        );
        expect(
          markerAt(markers, 'detached-race-d', 'end'),
          timeline
        ).toBeLessThanOrEqual(markerAt(markers, 'workflow', 'return'));
      }
    }, 30_000);

    it.each([
      [
        'retrying race loser',
        retryingRaceLoserWithDetachedTerminalDrain,
        undefined,
      ],
      ['queued race loser', queuedRaceLoserWithDetachedTerminalDrain, '1'],
    ] as const)(
      'does not hang after a %s creates detached terminal-drain steps',
      async (_tag, workflow, maxInlineSteps) => {
        const runs = Number(
          process.env.WORKFLOW_ADVANCE_ONLY_HANG_REPRO_RUNS ?? '20'
        );
        for (let index = 0; index < runs; index++) {
          const result = await terminalDrainRaceCompletes(
            workflow,
            `terminal-drain-${index}`,
            maxInlineSteps
          );
          expect
            .soft(
              result.completed,
              `run ${index + 1}/${runs} did not complete within 15 seconds\n${result.events}`
            )
            .toBe(true);
        }
      },
      330_000
    );

    it('records a running race loser before the workflow failure', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'workflow-4457-failure-race-'));
      const markerPath = join(dir, 'timeline.log');
      try {
        const run = await start(failAfterRaceLoser, [markerPath]);
        await expect(run.returnValue).rejects.toThrow('boom');
        const world = await getWorld();
        const { data: events } = await world.events.list({ runId: run.runId });
        const completed = events
          .map((event) => event.eventType)
          .reduce<number[]>((indexes, eventType, index) => {
            if (eventType === 'step_completed') indexes.push(index);
            return indexes;
          }, []);
        const runFailed = events.findIndex(
          (event) => event.eventType === 'run_failed'
        );
        expect(completed).toHaveLength(2);
        expect(completed[1]).toBeLessThan(runFailed);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it('does not execute a step twice across repeated early replays', async () => {
      for (let run = 0; run < 10; run++) {
        const { markers, timeline } = await runWithTimeline(
          duplicateProbe,
          [0, 0],
          `duplicate-probe-${run}`
        );
        for (const label of [
          'probe-fast-1',
          'probe-fast-2',
          'probe-fast-3',
          'probe-slow',
        ]) {
          expect(
            markers.filter(
              (marker) => marker.label === label && marker.phase === 'start'
            ),
            timeline
          ).toHaveLength(1);
          expect(
            markers.filter(
              (marker) => marker.label === label && marker.phase === 'end'
            ),
            timeline
          ).toHaveLength(1);
        }
      }
    });

    it('keeps workflowStartedAt stable from turbo through a background replay', async () => {
      const original = process.env.WORKFLOW_MAX_INLINE_STEPS;
      process.env.WORKFLOW_MAX_INLINE_STEPS = '0';
      try {
        const run = await start(workflowStartedAtAcrossBackgroundReplay, []);
        const timestamps = await run.returnValue;
        expect(timestamps.replay).toBe(timestamps.firstInvocation);
      } finally {
        if (original === undefined) {
          delete process.env.WORKFLOW_MAX_INLINE_STEPS;
        } else {
          process.env.WORKFLOW_MAX_INLINE_STEPS = original;
        }
      }
    });
  }
);

type Measurement = {
  wallMs: number;
  cpuMs: number;
  advanceGapMs?: number;
  detachedStartMs?: number;
  detachedEndMs?: number;
  returnMs?: number;
};

async function measure(
  workflow:
    | typeof chainedFanoutBenchmark
    | typeof oneStepFanoutBenchmark
    | typeof twoDifferentLeafBenchmark
    | typeof twoLeafBenchmark,
  args: number[]
): Promise<Measurement> {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const run = await start(workflow, args as never);
  await run.returnValue;
  const cpu = process.cpuUsage(cpuStart);
  return {
    wallMs: Math.round(performance.now() - wallStart),
    cpuMs: Math.round((cpu.user + cpu.system) / 1_000),
  };
}

async function measureAdvanceGap(
  workflow:
    | typeof fastFirstParallelChains
    | typeof raceThenNext
    | typeof threeParallelChains,
  args: number[],
  tag: string,
  from: [string, Marker['phase']],
  to: [string, Marker['phase']]
): Promise<Measurement> {
  const cpuStart = process.cpuUsage();
  const { markers, wallMs } = await runWithTimeline(workflow, args, tag);
  const cpu = process.cpuUsage(cpuStart);
  return {
    wallMs: Math.round(wallMs),
    cpuMs: Math.round((cpu.user + cpu.system) / 1_000),
    advanceGapMs:
      markerAt(markers, to[0], to[1]) - markerAt(markers, from[0], from[1]),
  };
}

async function measureDetached(tag: string): Promise<Measurement> {
  const cpuStart = process.cpuUsage();
  const { markers } = await runDetachedAfterAdvanceOnlyReplay(tag, 1_700);
  const cpu = process.cpuUsage(cpuStart);
  const firstAt = markers[0]?.at ?? 0;
  const detachedStart = markers.find(
    (marker) => marker.label === 'detached-race-d' && marker.phase === 'start'
  );
  const detachedEnd = markers.find(
    (marker) => marker.label === 'detached-race-d' && marker.phase === 'end'
  );
  const returnedAt = markerAt(markers, 'workflow', 'return');
  return {
    wallMs: returnedAt - firstAt,
    cpuMs: Math.round((cpu.user + cpu.system) / 1_000),
    ...(detachedStart ? { detachedStartMs: detachedStart.at - firstAt } : {}),
    ...(detachedEnd ? { detachedEndMs: detachedEnd.at - firstAt } : {}),
    returnMs: returnedAt - firstAt,
  };
}

async function measureTerminalDrainRace(
  workflow:
    | typeof retryingRaceLoserWithDetachedTerminalDrain
    | typeof queuedRaceLoserWithDetachedTerminalDrain,
  tag: string,
  maxInlineSteps?: string
): Promise<Measurement> {
  const cpuStart = process.cpuUsage();
  const result = await terminalDrainRaceCompletes(
    workflow,
    tag,
    maxInlineSteps
  );
  const cpu = process.cpuUsage(cpuStart);
  if (!result.completed) {
    throw new Error(`terminal-drain race timed out\n${result.events}`);
  }
  return {
    wallMs: result.wallMs,
    cpuMs: Math.round((cpu.user + cpu.system) / 1_000),
  };
}

async function runBenchmarks(): Promise<Record<string, Measurement[]>> {
  const results: Record<string, Measurement[]> = {};
  const selectedMode = process.env.WORKFLOW_ADVANCE_ONLY_BENCHMARK_MODE;
  const selectedShape = process.env.WORKFLOW_ADVANCE_ONLY_BENCHMARK_SHAPE;
  const rounds = Number(
    process.env.WORKFLOW_ADVANCE_ONLY_BENCHMARK_ROUNDS ?? '2'
  );
  const warmups = Number(
    process.env.WORKFLOW_ADVANCE_ONLY_BENCHMARK_WARMUPS ?? '0'
  );
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error('WORKFLOW_ADVANCE_ONLY_BENCHMARK_ROUNDS must be positive');
  }
  if (!Number.isInteger(warmups) || warmups < 0) {
    throw new Error(
      'WORKFLOW_ADVANCE_ONLY_BENCHMARK_WARMUPS must be non-negative'
    );
  }
  for (const mode of ['old', 'new'] as const) {
    if (selectedMode && selectedMode !== mode) continue;
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY = mode === 'old' ? '0' : '1';
    for (const [shape, workflow, args] of [
      ['2x1-noop', twoLeafBenchmark, [0]],
      ['2x1-200ms', twoLeafBenchmark, [200]],
      ['2x1-200-800ms', twoDifferentLeafBenchmark, [200, 800]],
      ['8x4', chainedFanoutBenchmark, [8, 4]],
      ['64x1', oneStepFanoutBenchmark, [64]],
      ['256x1', oneStepFanoutBenchmark, [256]],
    ] as const) {
      if (
        selectedShape &&
        selectedShape !== shape &&
        !(
          selectedShape === 'two-leaf-all' &&
          (shape === '2x1-noop' || shape === '2x1-200ms')
        )
      ) {
        continue;
      }
      for (let warmup = 0; warmup < warmups; warmup++) {
        await measure(workflow, [...args]);
      }
      results[`${mode}-${shape}`] = [];
      for (let round = 0; round < rounds; round++) {
        results[`${mode}-${shape}`].push(await measure(workflow, [...args]));
      }
      console.log(
        `${mode}-${shape}: ${JSON.stringify(results[`${mode}-${shape}`])}`
      );
    }

    for (const [shape, workflow, args, from, to, pendingLimit] of [
      [
        'two-chains',
        fastFirstParallelChains,
        [200, 2_000],
        ['fast1', 'end'],
        ['fast2', 'start'],
        '1',
      ],
      [
        'race-then-next',
        raceThenNext,
        [200, 2_000],
        ['race-fast', 'end'],
        ['race-next', 'start'],
        '1',
      ],
      ...([300, 600, 1_500] as const).map(
        (slowMs) =>
          [
            `short-beside-${slowMs}`,
            caughtSlowPromiseChain,
            [slowMs, 100],
            ['short', 'end'],
            ['next', 'start'],
            '1',
          ] as const
      ),
      [
        'three-chains-limit-1',
        threeParallelChains,
        [100, 500],
        ['three-fast-1', 'end'],
        ['three-fast-2', 'start'],
        '1',
      ],
      [
        'three-chains-limit-2',
        threeParallelChains,
        [100, 500],
        ['three-fast-1', 'end'],
        ['three-fast-2', 'start'],
        '2',
      ],
      [
        'three-chains-limit-4',
        threeParallelChains,
        [100, 500],
        ['three-fast-1', 'end'],
        ['three-fast-2', 'start'],
        '4',
      ],
    ] as const) {
      if (
        selectedShape &&
        selectedShape !== shape &&
        !(
          selectedShape === 'short-beside-all' &&
          shape.startsWith('short-beside-')
        )
      ) {
        continue;
      }
      process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING = pendingLimit;
      for (let warmup = 0; warmup < warmups; warmup++) {
        await measureAdvanceGap(
          workflow,
          [...args],
          `${mode}-${shape}-warmup-${warmup}`,
          from,
          to
        );
      }
      results[`${mode}-${shape}`] = [];
      for (let round = 0; round < rounds; round++) {
        results[`${mode}-${shape}`].push(
          await measureAdvanceGap(
            workflow,
            [...args],
            `${mode}-${shape}-${round}`,
            from,
            to
          )
        );
      }
      console.log(
        `${mode}-${shape}: ${JSON.stringify(results[`${mode}-${shape}`])}`
      );
    }

    if (!selectedShape || selectedShape === 'detached-race') {
      for (let warmup = 0; warmup < warmups; warmup++) {
        await measureDetached(`${mode}-detached-race-warmup-${warmup}`);
      }
      results[`${mode}-detached-race`] = [];
      for (let round = 0; round < rounds; round++) {
        results[`${mode}-detached-race`].push(
          await measureDetached(`${mode}-detached-race-${round}`)
        );
      }
      console.log(
        `${mode}-detached-race: ${JSON.stringify(results[`${mode}-detached-race`])}`
      );
    }

    for (const [shape, workflow, maxInlineSteps] of [
      [
        'retrying-terminal-drain',
        retryingRaceLoserWithDetachedTerminalDrain,
        undefined,
      ],
      ['queued-terminal-drain', queuedRaceLoserWithDetachedTerminalDrain, '1'],
    ] as const) {
      if (selectedShape && selectedShape !== shape) continue;
      for (let warmup = 0; warmup < warmups; warmup++) {
        await measureTerminalDrainRace(
          workflow,
          `${mode}-${shape}-warmup-${warmup}`,
          maxInlineSteps
        );
      }
      results[`${mode}-${shape}`] = [];
      for (let round = 0; round < rounds; round++) {
        results[`${mode}-${shape}`].push(
          await measureTerminalDrainRace(
            workflow,
            `${mode}-${shape}-${round}`,
            maxInlineSteps
          )
        );
      }
      console.log(
        `${mode}-${shape}: ${JSON.stringify(results[`${mode}-${shape}`])}`
      );
    }
  }
  return results;
}

describe.runIf(
  process.env.WORKFLOW_ADVANCE_ONLY_BENCHMARK === '1' &&
    process.env.WORKFLOW_VM !== 'quickjs'
)('advance-only replay benchmark', () => {
  it('compares two rounds of chained and one-step fan-outs', async () => {
    const original = process.env.WORKFLOW_ADVANCE_ONLY_REPLAY;
    const originalPendingLimit =
      process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING;
    let results: Record<string, Measurement[]>;
    try {
      results = await runBenchmarks();
    } finally {
      if (original === undefined) {
        delete process.env.WORKFLOW_ADVANCE_ONLY_REPLAY;
      } else {
        process.env.WORKFLOW_ADVANCE_ONLY_REPLAY = original;
      }
      if (originalPendingLimit === undefined) {
        delete process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING;
      } else {
        process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING =
          originalPendingLimit;
      }
    }
    console.log(JSON.stringify(results, null, 2));
    if (process.env.WORKFLOW_ADVANCE_ONLY_BENCHMARK_OUTPUT) {
      await writeFile(
        process.env.WORKFLOW_ADVANCE_ONLY_BENCHMARK_OUTPUT,
        `${JSON.stringify(results, null, 2)}\n`
      );
    }
    expect(Object.keys(results).length).toBeGreaterThan(0);
  }, 300_000);
});
