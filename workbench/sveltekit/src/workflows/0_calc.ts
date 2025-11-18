// import { FatalError } from 'workflow';

export async function calc(n: number) {
  'use workflow';
  console.log('Simple workflow started');
  n = await pow(n);
  console.log('Simple workflow finished');
  return n;
}

async function pow(a: number): Promise<number> {
  'use step';
  console.log('Running step pow with arg:', a);
  return a * a;
}
