import { sleep } from 'workflow';

export async function test() {
  'use workflow';
  console.log('Starting workflow');
  await sleep('1m');
  console.log('Workflow completed');
  return 'Hello, world!';
}
