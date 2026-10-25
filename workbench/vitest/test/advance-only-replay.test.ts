import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForHook, waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { getRun, resumeHook, start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import {
  attributesThenSleepBesideSlow,
  caughtSlowPromiseChain,
  chainedFanoutBenchmark,
  coalescingWindowStress,
  detachedAfterAdvanceOnlyReplay,
  detachedStep,
  duplicateProbe,
  failAfterRaceLoser,
  fanoutEpisodeReset,
  fastFirstParallelChains,
  fourChainsBesideOlderBackground,
  hookAfterRaceLoser,
  nestedParallelToolsBesideSlowAgent,
  oneStepFanoutBenchmark,
  parallelChainsBenchmark,
  queuedRaceLoserWithDetachedTerminalDrain,
  raceLoser,
  raceThenNext,
  retryingBranchBesideSlowSibling,
  retryingRaceLoserWithDetachedTerminalDrain,
  retryRaceWithDetachedDownstream,
  sleepAfterRaceLoser,
  slowFirstParallelChains,
  threeParallelChains,
  twoDifferentLeafBenchmark,
  twoDifferentLeafDurations,
  twoLeafBenchmark,
  twoLeafPromiseAll,
  wakeUpAfterRaceLoser,
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
    | typeof coalescingWindowStress
    | typeof twoLeafPromiseAll
    | typeof raceThenNext
    | typeof threeParallelChains
    | typeof twoDifferentLeafDurations
    | typeof detachedAfterAdvanceOnlyReplay
    | typeof detachedStep
    | typeof raceLoser
    | typeof duplicateProbe
    | typeof fanoutEpisodeReset
    | typeof fourChainsBesideOlderBackground
    | typeof attributesThenSleepBesideSlow
    | typeof parallelChainsBenchmark
    | typeof nestedParallelToolsBesideSlowAgent
    | typeof retryingBranchBesideSlowSibling
    | typeof retryRaceWithDetachedDownstream,
  args: (number | string)[],
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
  maxInlineSteps?: string,
  observeAfterReturnMs = 0
): Promise<{
  completed: boolean;
  events: string;
  markers: Marker[];
  timeline: string;
  terminalAt?: number;
  wallMs: number;
}> {
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
    const returnWallMs = Math.round(performance.now() - wallStart);
    if (completed && observeAfterReturnMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, observeAfterReturnMs));
    }
    const world = await getWorld();
    const eventPage = await world.events.list({ runId: run.runId });
    const events = eventPage.data
      .map((event) =>
        event.eventType === 'step_created'
          ? `${event.eventType}:${event.correlationId}:creation-only`
          : `${event.eventType}:${event.correlationId ?? ''}`
      )
      .join(', ');
    const terminalAt = eventPage.data
      .find(
        (event) =>
          event.eventType === 'run_completed' ||
          event.eventType === 'run_failed'
      )
      ?.createdAt.getTime();
    if (!completed) await run.cancel({ cancelReason: 'repro timeout' });
    const markers = parseMarkers(
      await readFile(markerPath, 'utf8').catch(() => '')
    );
    return {
      completed,
      events,
      markers,
      timeline: formatTimeline(tag, markers),
      terminalAt,
      wallMs: returnWallMs,
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

async function withUnknownStepCreatedFieldsDropped<T>(fn: () => Promise<T>) {
  const world = await getWorld();
  const originalList = world.events.list;
  const originalCreate = world.events.create;
  type ListedEvent = Awaited<ReturnType<typeof originalList>>['data'][number];
  const stripUnknownStepCreatedFields = (event: ListedEvent): ListedEvent => {
    if (event.eventType !== 'step_created') return event;
    const { stepName, workflowName, input } = event.eventData;
    return { ...event, eventData: { stepName, workflowName, input } };
  };
  world.events.list = (async (...args: Parameters<typeof originalList>) => {
    const page = await originalList.apply(world.events, args);
    return {
      ...page,
      data: page.data.map(stripUnknownStepCreatedFields),
    };
  }) as typeof originalList;
  world.events.create = (async (...args: Parameters<typeof originalCreate>) => {
    const forwarded = [...args] as Parameters<typeof originalCreate>;
    const request = forwarded[1];
    if (request.eventType === 'step_created') {
      const { stepName, workflowName, input } = request.eventData;
      forwarded[1] = {
        ...request,
        eventData: { stepName, workflowName, input },
      };
    }
    const result = await originalCreate.apply(world.events, forwarded);
    const returned = result as typeof result & {
      event?: ListedEvent;
      events?: ListedEvent[];
    };
    return {
      ...result,
      ...(returned.event
        ? { event: stripUnknownStepCreatedFields(returned.event) }
        : {}),
      ...(returned.events
        ? { events: returned.events.map(stripUnknownStepCreatedFields) }
        : {}),
    };
  }) as typeof originalCreate;
  try {
    return await fn();
  } finally {
    world.events.list = originalList;
    world.events.create = originalCreate;
  }
}

async function withTerminalBackstopSendCount<T>(fn: () => Promise<T>): Promise<{
  result: T;
  sends: number;
}> {
  const world = await getWorld();
  const originalQueue = world.queue;
  let sends = 0;
  world.queue = (async (...args: Parameters<typeof originalQueue>) => {
    const payload = args[1] as { terminalBackstop?: unknown };
    if (payload.terminalBackstop === true) sends++;
    return originalQueue.apply(world, args);
  }) as typeof originalQueue;
  try {
    return { result: await fn(), sends };
  } finally {
    world.queue = originalQueue;
  }
}

async function ordinaryWakeTerminalGuard(
  kind: 'hook' | 'sleep' | 'wakeUp'
): Promise<{
  events: Array<{ eventType: string }>;
  markers: Marker[];
  returnedAt: number;
  safetyProbeSends: number;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-4457-terminal-guard-'));
  const markerPath = join(dir, 'timeline.log');
  const loserMs = 2_500;
  const token = `terminal-guard-${kind}-${Math.random().toString(36).slice(2)}`;
  try {
    const startedAt = Date.now();
    const { result, sends } = await withTerminalBackstopSendCount(async () => {
      const run =
        kind === 'hook'
          ? await start(hookAfterRaceLoser, [markerPath, token, loserMs])
          : kind === 'sleep'
            ? await start(sleepAfterRaceLoser, [markerPath, loserMs])
            : await start(wakeUpAfterRaceLoser, [markerPath, loserMs]);
      if (kind === 'hook') {
        await waitForHook(run, { token });
        await resumeHook(token, { resumed: true });
      } else if (kind === 'wakeUp') {
        const waitId = await waitForSleep(run);
        await getRun(run.runId).wakeUp({ correlationIds: [waitId] });
      }
      await expect(run.returnValue).resolves.toBe('done');
      const returnedAt = Date.now();
      // On a regression the run returns before the loser settles. Keep the
      // queue wrapper installed long enough to observe its eventual replay.
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(100, startedAt + loserMs + 200 - Date.now())
        )
      );
      const world = await getWorld();
      const { data: events } = await world.events.list({ runId: run.runId });
      return { events, returnedAt };
    });
    return {
      ...result,
      markers: parseMarkers(await readFile(markerPath, 'utf8')),
      safetyProbeSends: sends,
    };
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

    it('keeps terminal safety sends constant for a long race loser', async () => {
      const { sends } = await withTerminalBackstopSendCount(() =>
        runWithTimeline(raceLoser, [2_000, 0], 'long-race-loser')
      );
      expect(sends).toBe(1);
    });

    it('keeps terminal safety sends constant for a retrying race loser', async () => {
      const { result, sends } = await withTerminalBackstopSendCount(() =>
        terminalDrainRaceCompletes(
          retryingRaceLoserWithDetachedTerminalDrain,
          'retrying-race-loser'
        )
      );
      expect(result.completed, result.events).toBe(true);
      expect(sends).toBe(1);
    });

    it('completes concurrent batches around the coalescing window without duplicate bodies', async () => {
      const runs = await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          runWithTimeline(
            coalescingWindowStress,
            [40, 40 + (index % 25)],
            `coalescing-stress-${index}`
          )
        )
      );
      for (const { markers, timeline } of runs) {
        for (const label of ['coalesce-a', 'coalesce-b']) {
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
    }, 60_000);

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

    it.each([
      3, 4,
    ] as const)('advances %s agent chains at the default pending limit', async (width) => {
      const { markers, timeline } = await runWithTimeline(
        parallelChainsBenchmark,
        [width, 100, 500],
        `${width}-chains-default`
      );
      const fast2 = markerAt(markers, 'many-fast-2', 'start');
      for (let index = 1; index < width; index++) {
        expect(fast2, timeline).toBeLessThan(
          markerAt(markers, `many-slow-${index}-1`, 'end')
        );
      }
    });

    it('resets eligibility after a completed wide fan-out', async () => {
      const { markers, timeline } = await runWithTimeline(
        fanoutEpisodeReset,
        [100, 600],
        'fanout-episode-reset'
      );
      const twoGap =
        markerAt(markers, 'episode-two-fast-2', 'start') -
        markerAt(markers, 'episode-two-fast-1', 'end');
      const fourGap =
        markerAt(markers, 'episode-four-fast-2', 'start') -
        markerAt(markers, 'episode-four-fast-1', 'end');
      expect(
        markerAt(markers, 'episode-two-fast-2', 'start'),
        timeline
      ).toBeLessThan(markerAt(markers, 'episode-two-slow-1', 'end'));
      expect(
        markerAt(markers, 'episode-four-fast-2', 'start'),
        timeline
      ).toBeLessThan(markerAt(markers, 'episode-four-slow-1-1', 'end'));
      expect(fourGap, timeline).toBeLessThanOrEqual(twoGap * 2 + 100);
    });

    it('scopes four agent chains apart from an older background step', async () => {
      const world = await getWorld();
      const originalQueue = world.queue;
      let handOffs = 0;
      world.queue = (async (...args: Parameters<typeof originalQueue>) => {
        const payload = args[1] as { advanceOnly?: unknown };
        if (payload.advanceOnly === true) handOffs++;
        return originalQueue.apply(world, args);
      }) as typeof originalQueue;
      let markers: Marker[];
      let timeline: string;
      try {
        ({ markers, timeline } = await runWithTimeline(
          fourChainsBesideOlderBackground,
          [100, 700, 2_000],
          'four-chains-older-background'
        ));
      } finally {
        world.queue = originalQueue;
      }
      expect(handOffs, timeline).toBeGreaterThanOrEqual(2);
      expect(
        markerAt(markers, 'background-fast-2', 'start'),
        timeline
      ).toBeLessThan(markerAt(markers, 'background-slow-1-1', 'end'));
      expect(
        markerAt(markers, 'background-fast-2', 'start'),
        timeline
      ).toBeLessThan(markerAt(markers, 'older-background', 'end'));
    });

    it('publishes a sleep continuation across an attribute replay detour', async () => {
      const { markers, timeline } = await runWithTimeline(
        attributesThenSleepBesideSlow,
        [3_000],
        'attributes-sleep-beside-slow'
      );
      expect(
        markerAt(markers, 'attribute-after-sleep', 'start'),
        timeline
      ).toBeLessThan(markerAt(markers, 'attribute-slow', 'end'));
      const sleepGap =
        markerAt(markers, 'attribute-after-sleep', 'start') -
        markerAt(markers, 'attribute-fast', 'end');
      expect(sleepGap, timeline).toBeGreaterThanOrEqual(900);
      expect(sleepGap, timeline).toBeLessThan(2_500);
    });

    it.each([
      [
        'hook resume',
        'hook',
        'ordinary-hook-loser',
        'ordinary-hook-after-wake',
      ],
      [
        'timer continuation',
        'sleep',
        'ordinary-sleep-loser',
        'ordinary-sleep-after-wake',
      ],
      [
        'run.wakeUp()',
        'wakeUp',
        'ordinary-wake-loser',
        'ordinary-wake-after-wake',
      ],
    ] as const)(
      'guards terminal writes in an ordinary %s replay while a race loser runs',
      async (_label, kind, loserLabel, afterWakeLabel) => {
        const { events, markers, returnedAt, safetyProbeSends } =
          await ordinaryWakeTerminalGuard(kind);
        const timeline = formatTimeline(`ordinary-${kind}`, markers);
        expect(
          markerAt(markers, afterWakeLabel, 'start'),
          timeline
        ).toBeLessThan(markerAt(markers, loserLabel, 'end'));
        expect(
          markerAt(markers, loserLabel, 'end'),
          timeline
        ).toBeLessThanOrEqual(returnedAt);
        expect(
          events.filter((event) => event.eventType === 'run_completed')
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.eventType === 'run_failed')
        ).toHaveLength(0);
        expect(safetyProbeSends).toBe(1);
      },
      15_000
    );

    it.each([
      ['plain Error', 'error', 0, 900],
      ['RetryableError with retryAfter', 'retryable', 1_200, 1_100],
    ] as const)(
      'retries a branch without waiting for its slow sibling (%s)',
      async (_label, errorKind, retryAfterMs, minimumBackoffMs) => {
        const { markers, timeline } = await runWithTimeline(
          retryingBranchBesideSlowSibling,
          [errorKind, 4_000, retryAfterMs],
          `retry-beside-slow-${errorKind}`
        );
        const retryDelay =
          markerAt(markers, 'retry-once-2', 'start') -
          markerAt(markers, 'retry-once-1', 'start');
        expect(retryDelay, timeline).toBeGreaterThanOrEqual(minimumBackoffMs);
        expect(
          markerAt(markers, 'retry-once-2', 'start'),
          timeline
        ).toBeLessThan(markerAt(markers, 'retry-slow-sibling', 'end'));
        expect(markerAt(markers, 'retry-next', 'start'), timeline).toBeLessThan(
          markerAt(markers, 'retry-slow-sibling', 'end')
        );
        for (const label of [
          'retry-once-1',
          'retry-once-2',
          'retry-next',
          'retry-slow-sibling',
        ]) {
          expect(
            markers.filter(
              (marker) => marker.label === label && marker.phase === 'start'
            ),
            timeline
          ).toHaveLength(1);
        }
      },
      15_000
    );

    it('keeps an inline retry behind its sibling when advance-only replay is disabled', async () => {
      const original = process.env.WORKFLOW_ADVANCE_ONLY_REPLAY;
      process.env.WORKFLOW_ADVANCE_ONLY_REPLAY = '0';
      try {
        const { markers, timeline } = await runWithTimeline(
          retryingBranchBesideSlowSibling,
          ['error', 1_500, 0],
          'retry-kill-switch'
        );
        expect(
          markerAt(markers, 'retry-once-2', 'start'),
          timeline
        ).toBeGreaterThanOrEqual(
          markerAt(markers, 'retry-slow-sibling', 'end')
        );
      } finally {
        if (original === undefined) {
          delete process.env.WORKFLOW_ADVANCE_ONLY_REPLAY;
        } else {
          process.env.WORKFLOW_ADVANCE_ONLY_REPLAY = original;
        }
      }
    });

    it('falls back to the end-of-batch retry publish when the early publish fails', async () => {
      const world = await getWorld();
      const originalQueue = world.queue;
      let failedEarlyPublish = false;
      world.queue = (async (...args: Parameters<typeof originalQueue>) => {
        const opts = args[2] as { delaySeconds?: unknown } | undefined;
        if (!failedEarlyPublish && typeof opts?.delaySeconds === 'number') {
          failedEarlyPublish = true;
          throw new Error('retry publish unavailable');
        }
        return originalQueue.apply(world, args);
      }) as typeof originalQueue;
      try {
        const { markers, timeline } = await runWithTimeline(
          retryingBranchBesideSlowSibling,
          ['error', 500, 0],
          'retry-publish-fallback'
        );
        expect(failedEarlyPublish).toBe(true);
        for (const label of ['retry-once-1', 'retry-once-2', 'retry-next']) {
          expect(
            markers.filter(
              (marker) => marker.label === label && marker.phase === 'start'
            ),
            timeline
          ).toHaveLength(1);
        }
      } finally {
        world.queue = originalQueue;
      }
    });

    it('does not complete after an early retry while detached downstream work is running', async () => {
      const { markers, timeline } = await runWithTimeline(
        retryRaceWithDetachedDownstream,
        ['retryable', 3_000, 200, 4_000],
        'retry-detached-terminal-guard'
      );
      expect(
        markerAt(markers, 'retry-downstream-fast', 'end'),
        timeline
      ).toBeLessThan(markerAt(markers, 'retry-race-slow', 'end'));
      expect(
        markerAt(markers, 'retry-downstream-slow', 'end'),
        timeline
      ).toBeGreaterThan(markerAt(markers, 'retry-race-slow', 'end'));
    }, 15_000);

    it.each([
      2, 4, 6,
    ] as const)('advances %s parallel tool calls inside one agent without waiting for a slow agent', async (toolCount) => {
      const { markers, timeline } = await runWithTimeline(
        nestedParallelToolsBesideSlowAgent,
        [1_500, toolCount],
        `nested-${toolCount}-tools-beside-slow-agent`
      );
      expect(
        markerAt(markers, 'agent-model-2', 'start'),
        timeline
      ).toBeLessThan(markerAt(markers, 'agent-slow-sibling', 'end'));
      for (let index = 1; index <= toolCount; index++) {
        expect(
          markerAt(markers, 'agent-model-2', 'start'),
          timeline
        ).toBeGreaterThanOrEqual(
          markerAt(markers, `agent-tool-${index}`, 'end')
        );
      }
      for (const label of [
        'agent-model-1',
        ...Array.from(
          { length: toolCount },
          (_, index) => `agent-tool-${index + 1}`
        ),
        'agent-model-2',
        'agent-slow-sibling',
      ]) {
        expect(
          markers.filter(
            (marker) => marker.label === label && marker.phase === 'start'
          ),
          timeline
        ).toHaveLength(1);
      }
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

    it.each([
      [
        'retrying race loser',
        retryingRaceLoserWithDetachedTerminalDrain,
        undefined,
        'flaky-terminal-drain',
        'flaky-race-loser-2',
      ],
      [
        'queued race loser',
        queuedRaceLoserWithDetachedTerminalDrain,
        '1',
        'queued-terminal-drain',
        'queued-race-loser',
      ],
    ] as const)(
      'does not run detached terminal-drain steps when a World drops unknown creation fields (%s)',
      async (
        tag,
        workflow,
        maxInlineSteps,
        detachedPrefix,
        terminalPredecessor
      ) => {
        const result = await withUnknownStepCreatedFieldsDropped(() =>
          terminalDrainRaceCompletes(
            workflow,
            `dropped-field-${tag.replaceAll(' ', '-')}`,
            maxInlineSteps,
            3_500
          )
        );
        const detachedStarts = result.markers.filter(
          (marker) =>
            marker.label.startsWith(detachedPrefix) && marker.phase === 'start'
        );
        expect
          .soft(
            result.completed,
            `returned after ${result.wallMs} ms\n${result.timeline}`
          )
          .toBe(true);
        expect.soft(detachedStarts, result.timeline).toEqual([]);
        expect(result.terminalAt, result.events).toBeDefined();
        const terminalAt = result.terminalAt ?? Number.POSITIVE_INFINITY;
        expect
          .soft(
            terminalAt - markerAt(result.markers, terminalPredecessor, 'end'),
            `terminal event lagged its predecessor\n${result.timeline}\n${result.events}`
          )
          .toBeLessThan(500);
      },
      40_000
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
    | typeof threeParallelChains
    | typeof parallelChainsBenchmark,
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
  const configuredPendingLimit =
    process.env.WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING ?? '3';
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
      ['3x1', oneStepFanoutBenchmark, [3]],
      ['4x1', oneStepFanoutBenchmark, [4]],
      ['5x1', oneStepFanoutBenchmark, [5]],
      ['8x1', oneStepFanoutBenchmark, [8]],
      ['8x4', chainedFanoutBenchmark, [8, 4]],
      ['64x1', oneStepFanoutBenchmark, [64]],
      ['128x1', oneStepFanoutBenchmark, [128]],
    ] as const) {
      if (
        selectedShape &&
        selectedShape !== shape &&
        !(
          selectedShape === 'two-leaf-all' &&
          (shape === '2x1-noop' || shape === '2x1-200ms')
        ) &&
        !(
          selectedShape === 'pending-limit-fanouts' &&
          ['3x1', '4x1', '5x1', '8x1', '8x4'].includes(shape)
        ) &&
        !(
          selectedShape === 'wide-fanout-controls' &&
          (shape === '64x1' || shape === '128x1')
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
      [
        'three-agent-chains',
        parallelChainsBenchmark,
        [3, 200, 1_500],
        ['many-fast-1', 'end'],
        ['many-fast-2', 'start'],
        configuredPendingLimit,
      ],
      [
        'four-agent-chains',
        parallelChainsBenchmark,
        [4, 200, 1_500],
        ['many-fast-1', 'end'],
        ['many-fast-2', 'start'],
        configuredPendingLimit,
      ],
    ] as const) {
      if (
        selectedShape &&
        selectedShape !== shape &&
        !(
          selectedShape === 'short-beside-all' &&
          shape.startsWith('short-beside-')
        ) &&
        !(
          selectedShape === 'agent-chains' &&
          (shape === 'three-agent-chains' || shape === 'four-agent-chains')
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
