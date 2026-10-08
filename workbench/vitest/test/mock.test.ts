/**
 * What `vi.mock()` does and does not reach under the `workflow()` plugin.
 * ../MOCKING.md explains the mechanism behind each case.
 *
 * Caveat for the npm-package cases: they hold because the generated bundles
 * are loaded through Vitest's module runner, which happens when
 * `@workflow/vitest` is itself processed by the runner — a workspace link like
 * this workbench, or `server.deps.inline`. In a plain `node_modules` install
 * the plugin is external, Node loads the bundle directly, and the step sees
 * the real package. MOCKING.md spells that out; do not read these two tests as
 * a guarantee for every install.
 */

import ms from 'ms';
import { describe, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import {
  durationWorkflow,
  durationWorkflowInline,
  durationWorkflowStepUtil,
} from '../workflows/third-party.js';

vi.mock('ms', () => ({
  default: () => 42,
}));

describe('third-party mocking', () => {
  it('vi.mock intercepts external npm package used in step', async () => {
    // Mock works outside the workflow bundle
    expect(ms('1h')).toBe(42);

    const run = await start(durationWorkflow, ['1h']);
    const result = await run.returnValue;

    // The step bundle keeps `ms` as an external import, so the step gets the
    // mock as well.
    expect(result).toEqual({ ms: 42 });
  });

  it.fails('vi.mock intercepts external npm package used in workflow', async () => {
    expect(ms('1h')).toBe(42);

    const run = await start(durationWorkflowInline, ['1h']);
    const result = await run.returnValue;

    // Workflow bodies run in the QuickJS VM from a bundled code string.
    // There is no module registry in there to intercept, so this is expected
    // to fail.
    expect(result).toEqual({ ms: 42 });
  });

  it('vi.mock intercepts an npm package reached through a local module', async () => {
    const run = await start(durationWorkflowStepUtil, ['1h']);
    const result = await run.returnValue;

    // workflows/utils.ts is inlined into the step bundle, but the `ms` import
    // it carries is hoisted into the bundle's own external imports, so the
    // mock still applies.
    expect(result).toEqual({ ms: 42 });
  });
});

describe('local module mocking', () => {
  it('does not reach a local module inlined into the step bundle', async () => {
    vi.doMock('../workflows/utils.js', () => ({
      formatDurationUtil: async () => 99,
    }));

    // The test's own module graph honours the mock.
    const mocked = await import('../workflows/utils.js');
    expect(await mocked.formatDurationUtil('1h')).toBe(99);

    const run = await start(durationWorkflowStepUtil, ['1h']);
    const result = (await run.returnValue) as { ms: number };

    // The step does not: esbuild inlined utils.ts into the bundle, so there is
    // no module left to swap. The value is whatever `ms` returned (42 here,
    // where the npm mock applies), never this mock's 99. Mock the npm leaf
    // instead, pass the dependency into the step, or unit test the step.
    expect(result.ms).not.toBe(99);

    vi.doUnmock('../workflows/utils.js');
  });
});
