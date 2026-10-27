import { appendFile } from 'node:fs/promises';
import { createHook, getStepMetadata, RetryableError } from 'workflow';

interface Span {
  name: string;
  start: number;
  end: number;
}

/** Sleeps `ms`, records its body entry in `markerPath`, returns its span. */
async function timedStep(name: string, ms: number, markerPath: string) {
  'use step';
  await appendFile(markerPath, `${name}\n`);
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { name, start, end: Date.now() } satisfies Span;
}

/** Like `timedStep`, but its first attempt throws a retryable error. */
async function retryOnceStep(name: string, ms: number, markerPath: string) {
  'use step';
  await appendFile(markerPath, `${name}\n`);
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  if (getStepMetadata().attempt === 1) {
    throw new RetryableError('first attempt', { retryAfter: 100 });
  }
  return { name, start, end: Date.now() } satisfies Span;
}

async function chain(
  prefix: string,
  ms: number,
  length: number,
  markerPath: string
): Promise<Span[]> {
  const spans: Span[] = [];
  for (let i = 1; i <= length; i++) {
    spans.push(await timedStep(`${prefix}${i}`, ms, markerPath));
  }
  return spans;
}

/** The #4457 shape: chains of steps running side by side in one body. */
export async function parallelChainsWorkflow(
  chains: { prefix: string; ms: number; length: number }[],
  markerPath: string
) {
  'use workflow';
  return await Promise.all(
    chains.map((c) => chain(c.prefix, c.ms, c.length, markerPath))
  );
}

/** A race whose loser is still running when the workflow returns. */
export async function raceLoserWorkflow(
  fastMs: number,
  slowMs: number,
  markerPath: string
) {
  'use workflow';
  const winner = await Promise.race([
    timedStep('fast', fastMs, markerPath),
    timedStep('slow', slowMs, markerPath),
  ]);
  return winner.name;
}

/** Same race, but the workflow throws once the winner settles. */
export async function raceLoserThenThrowWorkflow(
  fastMs: number,
  slowMs: number,
  markerPath: string
) {
  'use workflow';
  await Promise.race([
    timedStep('fast', fastMs, markerPath),
    timedStep('slow', slowMs, markerPath),
  ]);
  throw new Error('after race');
}

/** One branch reaches a hook while its sibling's step is still running. */
export async function chainIntoHookWorkflow(
  token: string,
  fastMs: number,
  slowMs: number,
  markerPath: string
) {
  'use workflow';
  const [fromHook, slow] = await Promise.all([
    (async () => {
      await timedStep('fast1', fastMs, markerPath);
      const hook = createHook<{ n: number }>({ token });
      const { n } = await hook;
      const after = await timedStep('fast2', fastMs, markerPath);
      return { n, after };
    })(),
    timedStep('slow', slowMs, markerPath),
  ]);
  return { n: fromHook.n, after: fromHook.after, slow };
}

/** A retrying step in one branch beside a slow step in the other. */
export async function retryBesideSlowWorkflow(
  fastMs: number,
  slowMs: number,
  markerPath: string
) {
  'use workflow';
  return await Promise.all([
    (async () => {
      const first = await retryOnceStep('flaky', fastMs, markerPath);
      const second = await timedStep('after-flaky', fastMs, markerPath);
      return [first, second];
    })(),
    timedStep('slow', slowMs, markerPath),
  ]);
}

/** A fan-out wider than the inline limit, with no follow-up steps. */
export async function leafFanOutWorkflow(widths: number[], markerPath: string) {
  'use workflow';
  return await Promise.all(
    widths.map((ms, i) => timedStep(`leaf${i}`, ms, markerPath))
  );
}
