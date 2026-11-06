import type { BaseBuilder } from '@workflow/builders';
import type { HotUpdateOptions } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { workflowHotUpdatePlugin } from './hot-update.js';

const WORKFLOW_SOURCE = `export async function flow() {\n  'use workflow';\n}\n`;

function setup() {
  const build = vi.fn(async () => {});
  const plugin = workflowHotUpdatePlugin({
    builder: { build } as unknown as BaseBuilder,
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
  return { build, hotUpdate, change };
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
});
