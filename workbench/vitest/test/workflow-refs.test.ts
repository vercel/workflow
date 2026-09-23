/**
 * Workflow references read from the test build's manifest, for tests that
 * name a workflow instead of importing it (and instead of hand-writing the
 * compiler-generated workflow id).
 */

import { getWorkflowRef, listWorkflowRefs } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';

describe('getWorkflowRef', () => {
  it('starts a workflow looked up by its exported name', async () => {
    const ref = getWorkflowRef('calculateWorkflow');

    expect(ref).toEqual({
      name: 'calculateWorkflow',
      file: 'workflows/simple.ts',
      workflowId: 'workflow//./workflows/simple//calculateWorkflow',
    });

    const run = await start(ref, [2, 7]);
    await expect(run.returnValue).resolves.toEqual({
      sum: 9,
      product: 14,
      combined: 23,
    });
  });

  it('accepts a file-qualified name', () => {
    expect(getWorkflowRef('workflows/simple.ts#calculateWorkflow')).toEqual(
      getWorkflowRef('calculateWorkflow')
    );
    // The file part matches by path suffix.
    expect(getWorkflowRef('simple.ts#calculateWorkflow')).toEqual(
      getWorkflowRef('calculateWorkflow')
    );
  });

  it('reports the workflows in the build when a name does not match', () => {
    expect(() => getWorkflowRef('noSuchWorkflow')).toThrow(
      /No workflow matching "noSuchWorkflow" was found in the test build\./
    );
    // A near miss on the name is suggested ahead of the full (truncated) list.
    expect(() => getWorkflowRef('calculate')).toThrow(
      /Did you mean: workflows\/simple\.ts#calculateWorkflow\?/
    );
  });
});

describe('listWorkflowRefs', () => {
  it('lists every workflow the test build compiled', () => {
    const refs = listWorkflowRefs();

    expect(refs.length).toBeGreaterThan(1);
    expect(refs).toContainEqual({
      name: 'hookWorkflow',
      file: 'workflows/hooks.ts',
      workflowId: 'workflow//./workflows/hooks//hookWorkflow',
    });
    // Every entry is usable as a start() argument.
    for (const ref of refs) {
      expect(ref.workflowId).toMatch(/^workflow\/\//);
    }
  });
});
