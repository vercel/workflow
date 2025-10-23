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
    for (let i = 0; i < 10; i++) {
      promises.push(noop(i));
    }

    console.log('await 10');
    numbers.push(...(await Promise.all(promises)));
  }

  {
    const promises: Promise<number>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(noop(1000 + i));
    }

    console.log('await 100');
    numbers.push(...(await Promise.all(promises)));
  }

  console.log('done.');

  return { numbers };
}
