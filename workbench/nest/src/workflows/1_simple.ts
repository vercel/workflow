import { FatalError } from 'workflow';

async function add(a: number, b: number): Promise<number> {
  'use step';

  // Mimic a retryable error 50% of the time
  if (Math.random() < 0.5) {
    throw new Error('Retryable error');
  }

  // Mimic a 5% chance of the workflow actually failing
  if (Math.random() < 0.05) {
    throw new FatalError("We're cooked yo!");
  }

  return a + b;
}

export async function simple(i: number) {
  'use workflow';
  console.log('Simple workflow started');

  const a = await add(i, 7);
  console.log('Workflow step 1 completed - Result:', a);

  const b = await add(a, 8);
  console.log('Simple workflow completed. Result:', b);

  return b;
}
