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
