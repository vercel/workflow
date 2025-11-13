import { applySwcTransform } from './src/apply-swc-transform';

const source = `
export async function promiseRaceStressTestDelayStep(
  dur: number,
  resp: number
): Promise<number> {
  'use step';

  console.log('sleep', resp, '/', dur);
  await new Promise((resolve) => setTimeout(resolve, dur));

  console.log(resp, 'done');
  return resp;
}

export async function promiseRaceStressTestWorkflow() {
  'use workflow';

  const promises = new Map<number, Promise<number>>();
  const done: number[] = [];
  for (let i = 0; i < 5; i++) {
    const resp = i;
    const dur = 1000 * 5 * i; // 5 seconds apart
    console.log('sched', resp, '/', dur);
    promises.set(i, promiseRaceStressTestDelayStep(dur, resp));
  }

  while (promises.size > 0) {
    console.log('promises.size', promises.size);
    const res = await Promise.race(promises.values());
    console.log(res);
    done.push(res);
    promises.delete(res);
  }

  return done;
}
`;

const result = await applySwcTransform('input.ts', source, 'workflow');
console.log(result.code);
