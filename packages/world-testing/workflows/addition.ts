import { RetryableError } from 'workflow';

async function add(num: number, num2: number): Promise<number> {
  'use step';
  if (Math.random() < 0.2) {
    throw new RetryableError('Random failure, please retry');
  }
  return num + num2;
}

export async function addition(num: number, num2: number): Promise<number> {
  'use workflow';
  const result = await add(num, num2);
  console.log({ result });
  return result;
}
