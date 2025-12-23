let count = 0;
export async function noop(_i: number) {
  'use step';

  count++;
  return count;
}

export async function brokenWf() {
  'use workflow';

  const numbers = [] as number[];

  {
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(noop(i));
    }

    console.log('await 5');
    numbers.push(...(await Promise.all(promises)));
  }

  {
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 15; i++) {
      promises.push(noop(100 + i));
    }

    console.log('await 15');
    numbers.push(...(await Promise.all(promises)));
  }

  console.log('done.');

  return { numbers };
}
