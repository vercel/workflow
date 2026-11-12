import { pathToFileURL } from 'node:url';
import type { AstroIntegration } from 'astro';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@workflow/builders', () => ({
  createBuildQueue: () => (fn: () => Promise<void>) => fn(),
}));

vi.mock('@workflow/rollup', () => ({
  workflowTransformPlugin: () => ({ name: 'workflow:transform' }),
}));

vi.mock('@workflow/vite', () => ({
  workflowHotUpdatePlugin: () => ({ name: 'workflow:hot-update' }),
}));

vi.mock('./builder.js', () => ({
  ASTRO_WORKER_FILE_NAME: 'worker.ts',
  LocalBuilder: class {
    build = async () => {};
  },
  VercelBuilder: class {
    build = async () => {};
  },
}));

import { workflowPlugin } from './plugin.js';

describe('workflowPlugin development worker', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Runs the integration's config and dev-server hooks against a stub Vite
   * server whose worker module records what the plugin did with it.
   */
  async function startDevServer(registers: boolean) {
    const calls: string[] = [];
    const plugin = workflowPlugin();
    const hooks = plugin.hooks as Required<AstroIntegration['hooks']>;
    const root = pathToFileURL('/app/');
    await hooks['astro:config:setup']({
      config: { root, srcDir: new URL('src/', root) },
      updateConfig: () => {},
    } as never);
    await hooks['astro:server:setup']({
      server: {
        ssrLoadModule: async (path: string) => {
          calls.push(`load ${path.endsWith('worker.ts')}`);
          return {
            registerWorkflowWorker: async () => {
              calls.push('register');
              return registers;
            },
            startWorkflowWorker: async () => {
              calls.push('start');
            },
          };
        },
      },
    } as never);
    return calls;
  }

  it('registers the route and starts the World when WORKFLOW_TARGET_WORLD names the Postgres World', async () => {
    vi.stubEnv('WORKFLOW_TARGET_WORLD', '@workflow/world-postgres');
    expect(await startDevServer(true)).toEqual([
      'load true',
      'register',
      'start',
    ]);
  });

  it('asks a custom World module, and starts it only when it took the route', async () => {
    vi.stubEnv('WORKFLOW_TARGET_WORLD', './my-world.ts');
    expect(await startDevServer(true)).toEqual([
      'load true',
      'register',
      'start',
    ]);
    expect(await startDevServer(false)).toEqual(['load true', 'register']);
  });

  it('does not build the Local or Vercel World at boot', async () => {
    for (const target of [
      undefined,
      'local',
      'vercel',
      '@workflow/world-local',
      '@workflow/world-vercel',
    ]) {
      vi.unstubAllEnvs();
      if (target) vi.stubEnv('WORKFLOW_TARGET_WORLD', target);
      expect(await startDevServer(true)).toEqual([]);
    }
  });

  it('runs no worker on a Vercel deploy', async () => {
    vi.stubEnv('WORKFLOW_TARGET_WORLD', '@workflow/world-postgres');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_x');
    expect(await startDevServer(true)).toEqual([]);
  });
});
