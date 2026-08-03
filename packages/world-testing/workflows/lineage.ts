import { start } from 'workflow/api';

async function noop(): Promise<void> {
  'use step';
}

/**
 * Body-level `start()`: a workflow that, from its own body (not from inside a
 * step), spawns a child run. This is the canonical child-workflow / daisy-chain
 * spawn the docs present. The child should inherit cross-run lineage.
 */
export async function bodyStartsChild(): Promise<string> {
  'use workflow';
  await noop();
  const child = await start(spawnedChild, []);
  return child.runId;
}

export async function spawnedChild(): Promise<string> {
  'use workflow';
  await noop();
  return 'done';
}

// Three-level chain: root → middle → leaf. The leaf is the first run whose
// $rootRunId and $parentRunId differ.
export async function chainRoot(): Promise<string> {
  'use workflow';
  await noop();
  const middle = await start(chainMiddle, []);
  return middle.runId;
}

export async function chainMiddle(): Promise<string> {
  'use workflow';
  await noop();
  const leaf = await start(chainLeaf, []);
  return leaf.runId;
}

export async function chainLeaf(): Promise<string> {
  'use workflow';
  await noop();
  return 'done';
}
