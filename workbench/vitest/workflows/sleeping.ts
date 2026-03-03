import { sleep } from 'workflow';

async function prepareData(input: string) {
  'use step';
  return `prepared:${input}`;
}

async function finalizeData(data: string) {
  'use step';
  return `finalized:${data}`;
}

export async function sleepingWorkflow(input: string) {
  'use workflow';

  const prepared = await prepareData(input);
  await sleep('24h');
  const result = await finalizeData(prepared);

  return result;
}

export async function multiSleepWorkflow(input: string) {
  'use workflow';

  const prepared = await prepareData(input);
  await sleep('1h');
  const intermediate = await finalizeData(prepared);
  await sleep('24h');

  return `done:${intermediate}`;
}
