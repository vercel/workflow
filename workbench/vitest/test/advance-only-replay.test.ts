import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import {
  caughtSlowPromiseChain,
  chainedFanoutBenchmark,
  fastFirstParallelChains,
  oneStepFanoutBenchmark,
  slowFirstParallelChains,
} from '../workflows/advance-only-replay.js';

const FAST_MS = 200;
const SLOW_MS = 3_000;
const SHORT_MS = 100;

type Marker = { label: string; phase: 'start' | 'end'; at: number };

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
    | typeof caughtSlowPromiseChain,
  args: [number, number],
  tag: string
): Promise<{ markers: Marker[]; timeline: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-4457-'));
  const markerPath = join(dir, 'timeline.log');
  try {
    const run = await start(workflow, [markerPath, ...args]);
    await run.returnValue;
    const markers = parseMarkers(await readFile(markerPath, 'utf8'));
    return { markers, timeline: formatTimeline(tag, markers) };
  } finally {
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
            `next started ${gap}ms after short ended, expected within 120ms\n${timeline}`
          )
          .toBeLessThanOrEqual(120);
      }
    });
  }
);

type Measurement = { wallMs: number; cpuMs: number };

async function measure(
  workflow: typeof chainedFanoutBenchmark | typeof oneStepFanoutBenchmark,
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

async function runBenchmarks(): Promise<Record<string, Measurement[]>> {
  const results: Record<string, Measurement[]> = {};
  const selectedMode = process.env.WORKFLOW_ADVANCE_ONLY_BENCHMARK_MODE;
  const selectedShape = process.env.WORKFLOW_ADVANCE_ONLY_BENCHMARK_SHAPE;
  for (const mode of ['old', 'new'] as const) {
    if (selectedMode && selectedMode !== mode) continue;
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY = mode === 'old' ? '0' : '1';
    for (const [shape, workflow, args] of [
      ['8x4', chainedFanoutBenchmark, [8, 4]],
      ['64x1', oneStepFanoutBenchmark, [64]],
      ['256x1', oneStepFanoutBenchmark, [256]],
    ] as const) {
      if (selectedShape && selectedShape !== shape) continue;
      results[`${mode}-${shape}`] = [
        await measure(workflow, [...args]),
        await measure(workflow, [...args]),
      ];
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
    let results: Record<string, Measurement[]>;
    try {
      results = await runBenchmarks();
    } finally {
      if (original === undefined) {
        delete process.env.WORKFLOW_ADVANCE_ONLY_REPLAY;
      } else {
        process.env.WORKFLOW_ADVANCE_ONLY_REPLAY = original;
      }
    }
    console.log(JSON.stringify(results, null, 2));
    expect(Object.keys(results).length).toBeGreaterThan(0);
  }, 300_000);
});
