import { appendFile } from 'node:fs/promises';

async function markerStep(markerPath: string, label: string, delayMs: number) {
  'use step';
  await appendFile(markerPath, `${label} start ${Date.now()}\n`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await appendFile(markerPath, `${label} end ${Date.now()}\n`);
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

export async function raceLoser(markerPath: string, loserMs: number) {
  'use workflow';
  await Promise.race([
    markerStep(markerPath, 'race-winner', 0),
    markerStep(markerPath, 'race-loser', loserMs),
  ]);
  return 'done';
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
