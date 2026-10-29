import type { BaseBuilder } from '@workflow/builders';
import type { HotUpdateOptions } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { workflowHotUpdatePlugin } from './hot-update.js';

const WORKFLOW_SOURCE = `export async function flow() {\n  'use workflow';\n}\n`;

type DiscoveredEntries = ReturnType<BaseBuilder['getSettledDiscoveredEntries']>;

function setup(discovered?: DiscoveredEntries) {
  const build = vi.fn(async () => {});
  const plugin = workflowHotUpdatePlugin({
    builder: {
      build,
      getSettledDiscoveredEntries: () => discovered,
    } as unknown as BaseBuilder,
  });
  const hotUpdate = plugin.hotUpdate as (
    ctx: HotUpdateOptions
  ) => Promise<unknown>;
  const change = (file: string, timestamp: number) =>
    ({
      type: 'update',
      file,
      timestamp,
      modules: [],
      read: async () => WORKFLOW_SOURCE,
      server: {},
    }) as unknown as HotUpdateOptions;
  const deletion = (file: string, timestamp: number) =>
    ({
      type: 'delete',
      file,
      timestamp,
      modules: [],
      read: async () => {
        throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      },
      server: {},
    }) as unknown as HotUpdateOptions;
  return { build, hotUpdate, change, deletion };
}

function discovery({
  workflows = [] as string[],
  steps = [] as string[],
  serde = [] as string[],
}): DiscoveredEntries {
  return {
    discoveredWorkflows: new Set(workflows),
    discoveredSteps: new Set(steps),
    discoveredSerdeFiles: new Set(serde),
  };
}

describe('workflowHotUpdatePlugin', () => {
  it('rebuilds once per file change, not once per Vite environment', async () => {
    const { build, hotUpdate, change } = setup();

    // Vite invokes `hotUpdate` for `client`, `ssr`, then each remaining
    // environment (e.g. Nitro's), all with the same change context.
    for (let environment = 0; environment < 3; environment++) {
      await hotUpdate(change('/app/workflows/flow.ts', 1_000));
    }

    expect(build).toHaveBeenCalledOnce();
  });

  it('rebuilds again for a later change to the same file', async () => {
    const { build, hotUpdate, change } = setup();

    await hotUpdate(change('/app/workflows/flow.ts', 1_000));
    await hotUpdate(change('/app/workflows/flow.ts', 1_000));
    await hotUpdate(change('/app/workflows/flow.ts', 2_000));

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('rebuilds once per change when changes to different files interleave', async () => {
    const { build, hotUpdate, change } = setup();

    // Vite handles each file's change concurrently, so one file's `ssr` call
    // can land between another file's `client` and `ssr` calls.
    await hotUpdate(change('/app/workflows/a.ts', 1_000));
    await hotUpdate(change('/app/workflows/b.ts', 1_001));
    await hotUpdate(change('/app/workflows/a.ts', 1_000));
    await hotUpdate(change('/app/workflows/b.ts', 1_001));

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('rebuilds once per change when changes to the same file interleave', async () => {
    const { build, hotUpdate, change } = setup();

    // A second write can arrive before the first change reaches `ssr`.
    await hotUpdate(change('/app/workflows/a.ts', 1_000));
    await hotUpdate(change('/app/workflows/a.ts', 1_050));
    await hotUpdate(change('/app/workflows/a.ts', 1_000));
    await hotUpdate(change('/app/workflows/a.ts', 1_050));

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('rebuilds for a change to a different file', async () => {
    const { build, hotUpdate, change } = setup();

    await hotUpdate(change('/app/workflows/a.ts', 1_000));
    await hotUpdate(change('/app/workflows/b.ts', 1_000));

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('does not rebuild when deleted files were not found by the last discovery', async () => {
    const { build, hotUpdate, deletion } = setup(
      discovery({ workflows: ['/app/workflows/flow.ts'] })
    );

    for (let index = 0; index < 30; index++) {
      await hotUpdate(deletion(`/app/src/lib/plain${index}.ts`, 1_000 + index));
    }

    expect(build).not.toHaveBeenCalled();
  });

  it.each([
    ['workflow', discovery({ workflows: ['/app/workflows/deleted.ts'] })],
    ['step', discovery({ steps: ['/app/workflows/deleted.ts'] })],
    ['serde', discovery({ serde: ['/app/workflows/deleted.ts'] })],
  ])('rebuilds when a deleted file was a discovered %s file', async (_, entries) => {
    const { build, hotUpdate, deletion } = setup(entries);

    await hotUpdate(deletion('/app/workflows/deleted.ts', 1_000));

    expect(build).toHaveBeenCalledOnce();
  });

  it('rebuilds for a deleted file while no discovery has settled', async () => {
    const { build, hotUpdate, deletion } = setup(undefined);

    await hotUpdate(deletion('/app/src/lib/plain.ts', 1_000));

    expect(build).toHaveBeenCalledOnce();
  });
});
