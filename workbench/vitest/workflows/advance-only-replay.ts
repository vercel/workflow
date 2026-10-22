import { appendFile } from 'node:fs/promises';
import { getStepMetadata, getWorkflowMetadata, RetryableError } from 'workflow';

async function markerStep(markerPath: string, label: string, delayMs: number) {
  'use step';
  await appendFile(markerPath, `${label} start ${Date.now()}\n`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await appendFile(markerPath, `${label} end ${Date.now()}\n`);
}

async function keepStartedAt(startedAt: number) {
  'use step';
  return startedAt;
}

export async function workflowStartedAtAcrossBackgroundReplay() {
  'use workflow';
  const firstInvocation = +getWorkflowMetadata().workflowStartedAt;
  const persistedFirstInvocation = await keepStartedAt(firstInvocation);
  return {
    firstInvocation: persistedFirstInvocation,
    replay: +getWorkflowMetadata().workflowStartedAt,
  };
}

async function fastChain(markerPath: string, delayMs: number) {
  await markerStep(markerPath, 'fast1', delayMs);
  await markerStep(markerPath, 'fast2', delayMs);
  await markerStep(markerPath, 'fast3', delayMs);
}

async function slowChain(markerPath: string, delayMs: number) {
  await markerStep(markerPath, 'slow1', delayMs);
  await markerStep(markerPath, 'slow2', delayMs);
  await markerStep(markerPath, 'slow3', delayMs);
}

export async function fastFirstParallelChains(
  markerPath: string,
  fastMs: number,
  slowMs: number
) {
  'use workflow';
  await Promise.all([
    fastChain(markerPath, fastMs),
    slowChain(markerPath, slowMs),
  ]);
}

export async function slowFirstParallelChains(
  markerPath: string,
  fastMs: number,
  slowMs: number
) {
  'use workflow';
  await Promise.all([
    slowChain(markerPath, slowMs),
    fastChain(markerPath, fastMs),
  ]);
}

export async function caughtSlowPromiseChain(
  markerPath: string,
  slowMs: number,
  shortMs: number
) {
  'use workflow';
  const t = markerStep(markerPath, 'slow', slowMs);
  t.catch(() => {});
  await markerStep(markerPath, 'short', shortMs);
  await markerStep(markerPath, 'next', 0);
  await t;
}

export async function twoLeafPromiseAll(markerPath: string, delayMs: number) {
  'use workflow';
  await Promise.all([
    markerStep(markerPath, 'leaf1', delayMs),
    markerStep(markerPath, 'leaf2', delayMs),
  ]);
}

export async function twoDifferentLeafDurations(
  markerPath: string,
  firstMs: number,
  secondMs: number
) {
  'use workflow';
  await Promise.all([
    markerStep(markerPath, 'different-leaf-1', firstMs),
    markerStep(markerPath, 'different-leaf-2', secondMs),
  ]);
}

export async function raceThenNext(
  markerPath: string,
  fastMs: number,
  slowMs: number
) {
  'use workflow';
  await Promise.race([
    markerStep(markerPath, 'race-fast', fastMs),
    markerStep(markerPath, 'race-slow', slowMs),
  ]);
  await markerStep(markerPath, 'race-next', 0);
}

async function namedChain(markerPath: string, prefix: string, delayMs: number) {
  for (let index = 1; index <= 3; index++) {
    await markerStep(markerPath, `${prefix}${index}`, delayMs);
  }
}

export async function threeParallelChains(
  markerPath: string,
  fastMs: number,
  slowMs: number
) {
  'use workflow';
  await Promise.all([
    namedChain(markerPath, 'three-fast-', fastMs),
    namedChain(markerPath, 'three-slow-a-', slowMs),
    namedChain(markerPath, 'three-slow-b-', slowMs),
  ]);
}

export async function detachedStep(markerPath: string, delayMs: number) {
  'use workflow';
  const detached = markerStep(markerPath, 'detached', delayMs);
  detached.catch(() => {});
  await markerStep(markerPath, 'detached-awaited', 0);
  return 'done';
}

export async function detachedAfterAdvanceOnlyReplay(
  markerPath: string,
  firstMs: number,
  detachedMs: number,
  siblingMs: number
) {
  'use workflow';
  await Promise.all([
    (async () => {
      await markerStep(markerPath, 'detached-race-a1', firstMs);
      const detached = markerStep(markerPath, 'detached-race-d', detachedMs);
      detached.catch(() => {});
    })(),
    markerStep(markerPath, 'detached-race-b', siblingMs),
  ]);
  return 'done';
}

export async function raceLoser(markerPath: string, loserMs: number) {
  'use workflow';
  await Promise.race([
    markerStep(markerPath, 'race-winner', 0),
    markerStep(markerPath, 'race-loser', loserMs),
  ]);
  return 'done';
}

async function flakySlowRaceLoser(markerPath: string) {
  'use step';
  const { attempt } = getStepMetadata();
  await appendFile(
    markerPath,
    `flaky-race-loser-${attempt} start ${Date.now()}\n`
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (attempt === 1) {
    throw new RetryableError('once', { retryAfter: 200 });
  }
  await appendFile(
    markerPath,
    `flaky-race-loser-${attempt} end ${Date.now()}\n`
  );
}

function startDetachedTerminalDrain(markerPath: string, prefix: string) {
  const detached = Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      markerStep(markerPath, `${prefix}-${index + 1}`, 50)
    )
  );
  detached.catch(() => {});
}

export async function retryingRaceLoserWithDetachedTerminalDrain(
  markerPath: string
) {
  'use workflow';
  const winner = await Promise.race([
    markerStep(markerPath, 'flaky-race-winner', 100),
    flakySlowRaceLoser(markerPath),
  ]);
  startDetachedTerminalDrain(markerPath, 'flaky-terminal-drain');
  return winner;
}

export async function queuedRaceLoserWithDetachedTerminalDrain(
  markerPath: string
) {
  'use workflow';
  const winner = await Promise.race([
    markerStep(markerPath, 'queued-race-winner', 100),
    markerStep(markerPath, 'queued-race-loser', 800),
  ]);
  startDetachedTerminalDrain(markerPath, 'queued-terminal-drain');
  return winner;
}

export async function failAfterRaceLoser(markerPath: string) {
  'use workflow';
  await Promise.race([
    markerStep(markerPath, 'failure-race-winner', 100),
    markerStep(markerPath, 'failure-race-loser', 1_500),
  ]);
  throw new Error('boom');
}

export async function duplicateProbe(markerPath: string) {
  'use workflow';
  await Promise.all([
    namedChain(markerPath, 'probe-fast-', 10),
    markerStep(markerPath, 'probe-slow', 40),
  ]);
}

async function benchmarkStep(delayMs: number) {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function chainedFanoutBenchmark(width: number, depth: number) {
  'use workflow';
  await Promise.all(
    Array.from({ length: width }, async (_, branch) => {
      for (let step = 0; step < depth; step++) {
        await benchmarkStep(50 + ((branch + step) % 6) * 10);
      }
    })
  );
}

export async function oneStepFanoutBenchmark(width: number) {
  'use workflow';
  await Promise.all(
    Array.from({ length: width }, (_, branch) =>
      benchmarkStep(50 + (branch % 6) * 10)
    )
  );
}

export async function twoLeafBenchmark(delayMs: number) {
  'use workflow';
  await Promise.all([benchmarkStep(delayMs), benchmarkStep(delayMs)]);
}

export async function twoDifferentLeafBenchmark(
  firstMs: number,
  secondMs: number
) {
  'use workflow';
  await Promise.all([benchmarkStep(firstMs), benchmarkStep(secondMs)]);
}
