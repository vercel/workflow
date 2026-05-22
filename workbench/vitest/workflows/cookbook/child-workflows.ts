import { getRun, start } from 'workflow/api';

async function processItem(item: string): Promise<string> {
  'use step';
  return `processed-${item}`;
}

// Child workflow
export async function childWorkflow(item: string) {
  'use workflow';

  const result = await processItem(item);
  return { item, result };
}

async function spawnChild(item: string): Promise<string> {
  'use step';

  const run = await start(childWorkflow, [item]);
  return run.runId;
}

async function collectResult(
  runId: string
): Promise<{ item: string; result: string }> {
  'use step';

  const run = getRun(runId);
  const value = await run.returnValue;
  return value as { item: string; result: string };
}

// Parent workflow — spawns one child and collects its result
export async function parentWorkflow(item: string) {
  'use workflow';

  const runId = await spawnChild(item);
  const result = await collectResult(runId);

  return { childRunId: runId, result };
}
