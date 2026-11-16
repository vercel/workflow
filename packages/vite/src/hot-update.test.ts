import { EventEmitter } from 'node:events';
import {
  type BaseBuilder,
  refreshInProcessWorkerRoute,
} from '@workflow/builders';
import type { HotUpdateOptions, ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowHotUpdatePlugin } from './hot-update.js';

vi.mock('@workflow/builders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workflow/builders')>()),
  refreshInProcessWorkerRoute: vi.fn(async () => {}),
}));

afterEach(() => {
  vi.mocked(refreshInProcessWorkerRoute).mockClear();
});

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

  it('hands the rebuilt flow route to a World that delivers in process, after the build, on the dev server port', async () => {
    const order: string[] = [];
    const build = vi.fn(async () => {
      order.push('build');
    });
    vi.mocked(refreshInProcessWorkerRoute).mockImplementation(async () => {
      order.push('refresh');
    });
    const plugin = workflowHotUpdatePlugin({
      builder: { build } as unknown as BaseBuilder,
    });
    const httpServer = Object.assign(new EventEmitter(), {
      address: () => ({ port: 5173, address: '::', family: 'IPv6' }),
    });
    (plugin.configureServer as (server: ViteDevServer) => void)({
      httpServer,
    } as unknown as ViteDevServer);
    httpServer.emit('listening');

    await (plugin.hotUpdate as (ctx: HotUpdateOptions) => Promise<unknown>)({
      type: 'update',
      file: '/app/workflows/flow.ts',
      timestamp: 1_000,
      modules: [],
      read: async () => WORKFLOW_SOURCE,
      server: {},
    } as unknown as HotUpdateOptions);

    expect(order).toEqual(['build', 'refresh']);
    expect(refreshInProcessWorkerRoute).toHaveBeenCalledExactlyOnceWith({
      port: 5173,
    });
  });

  it('does not hand over a route when nothing was rebuilt', async () => {
    const { build, hotUpdate, change } = setup();
    await hotUpdate({
      ...change('/app/styles.css', 1_000),
    } as HotUpdateOptions);
    expect(build).not.toHaveBeenCalled();
    expect(refreshInProcessWorkerRoute).not.toHaveBeenCalled();
  });
});
