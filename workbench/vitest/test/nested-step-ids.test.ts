import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { nestedStepBranchWorkflow } from '../workflows/nested-step-ids.js';

describe('nested step IDs', () => {
  it.each([
    ['a', 'body-a'],
    ['b', 'body-b'],
  ] as const)('runs branch %s with its own step body', async (branch, expected) => {
    const run = await start(nestedStepBranchWorkflow, [branch]);
    await expect(run.returnValue).resolves.toBe(expected);
  });
});
