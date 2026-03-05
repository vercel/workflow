import { computeSum, formatResult } from './_direct_call_helper';

export async function stepWithImportedHelper(a: number, b: number) {
  'use step';
  const sum = computeSum(a, b);
  return formatResult('sum', sum);
}
