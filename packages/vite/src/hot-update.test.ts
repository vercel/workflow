import type { HotUpdateOptions } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { workflowHotUpdatePlugin } from './hot-update.js';

function update(
  timestamp: number,
  {
    file = '/app/workflow.ts',
    source = `export function run() {\n  'use workflow';\n}`,
  }: { file?: string; source?: string } = {}
): HotUpdateOptions {
  return {
    type: 'update',
    file,
    modules: [],
    read: () => source,
    timestamp,
  } as HotUpdateOptions;
}

function builder(fileAffectsWorkflowBuild = () => false) {
  return {
    build: vi.fn(async () => {}),
    fileAffectsWorkflowBuild,
    invalidateWorkflowDependency: vi.fn(),
  };
}

function createHotUpdateHarness(fileAffectsWorkflowBuild = () => false) {
  const workflowBuilder = builder(fileAffectsWorkflowBuild);
  const plugin = workflowHotUpdatePlugin({ builder: workflowBuilder });
  return {
    workflowBuilder,
    hotUpdate: plugin.hotUpdate as (options: HotUpdateOptions) => Promise<void>,
  };
}

describe('workflowHotUpdatePlugin', () => {
  it('shares one rebuild across Vite environments', async () => {
    const { hotUpdate, workflowBuilder } = createHotUpdateHarness();
    const updateOptions = update(1);
    updateOptions.read = vi.fn(updateOptions.read);

    await Promise.all([
      hotUpdate(updateOptions),
      hotUpdate(updateOptions),
      hotUpdate(updateOptions),
    ]);

    expect(updateOptions.read).toHaveBeenCalledOnce();
    expect(workflowBuilder.build).toHaveBeenCalledOnce();
    expect(workflowBuilder.invalidateWorkflowDependency).toHaveBeenCalledOnce();
  });

  it('does not replay an older environment event after a newer rebuild', async () => {
    const { hotUpdate, workflowBuilder } = createHotUpdateHarness();

    await hotUpdate(update(1));
    await hotUpdate(update(2));
    await hotUpdate(update(1));

    expect(workflowBuilder.build).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when a directive-free dependency changes', async () => {
    const { hotUpdate, workflowBuilder } = createHotUpdateHarness(
      (file) => file === '/app/virtual-module/helper.ts'
    );

    await hotUpdate(
      update(1, {
        file: '/app/virtual-module/helper.ts',
        source: `export const helper = () => 'changed';`,
      })
    );

    expect(workflowBuilder.build).toHaveBeenCalledOnce();
    expect(workflowBuilder.invalidateWorkflowDependency).toHaveBeenCalledWith(
      '/app/virtual-module/helper.ts',
      1
    );
  });

  it.each([
    'mts',
    'cts',
  ])('rebuilds a new .%s workflow source file', async (extension) => {
    const { hotUpdate, workflowBuilder } = createHotUpdateHarness();

    await hotUpdate(update(1, { file: `/app/workflow.${extension}` }));

    expect(workflowBuilder.build).toHaveBeenCalledOnce();
  });

  it('rebuilds known non-code dependencies without reading them', async () => {
    const { hotUpdate, workflowBuilder } = createHotUpdateHarness(
      (file) => file === '/app/schema.json'
    );
    const updateOptions = update(1, { file: '/app/schema.json' });
    updateOptions.read = vi.fn(() => {
      throw new Error('non-code dependencies do not need source inspection');
    });

    await hotUpdate(updateOptions);

    expect(updateOptions.read).not.toHaveBeenCalled();
    expect(workflowBuilder.build).toHaveBeenCalledOnce();
  });

  it('ignores unrelated directive-free files', async () => {
    const { hotUpdate, workflowBuilder } = createHotUpdateHarness();

    await hotUpdate(
      update(1, {
        file: '/app/unrelated.ts',
        source: `export const unrelated = true;`,
      })
    );

    expect(workflowBuilder.build).not.toHaveBeenCalled();
  });
});
