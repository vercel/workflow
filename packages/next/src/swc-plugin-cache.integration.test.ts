import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished } from 'vitest';
import { prewarmWorkflowSwcPluginCache } from './swc-plugin-cache.js';

const execFileAsync = promisify(execFile);

const WORKER_SOURCE = `
const [swcCorePath, pluginPath, cacheRoot, workerId] = process.argv.slice(1);
const { transformSync } = require(swcCorePath);

transformSync(
  \`export async function worker\${workerId}() { 'use step'; }\`,
  {
    filename: \`worker-\${workerId}.js\`,
    swcrc: false,
    jsc: {
      experimental: {
        cacheRoot,
        plugins: [[pluginPath, { mode: 'step' }]],
      },
    },
  }
);
`;

describe('Workflow SWC plugin cache prewarming integration', () => {
  it('makes the compiled plugin safe for parallel worker reads', async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), 'workflow-swc-plugin-cache-')
    );
    onTestFinished(() => rm(projectRoot, { recursive: true }));

    prewarmWorkflowSwcPluginCache(projectRoot);

    const cacheRoot = join(projectRoot, '.swc');
    const cacheFiles = await readdir(cacheRoot, { recursive: true });
    expect(cacheFiles.some((file) => file.endsWith('.wasmer-v7'))).toBe(true);

    const swcCorePath = require.resolve('@swc/core');
    const swcPluginPath = require.resolve('@workflow/swc-plugin');
    await Promise.all(
      Array.from({ length: 16 }, (_, workerId) =>
        execFileAsync(
          process.execPath,
          [
            '-e',
            WORKER_SOURCE,
            swcCorePath,
            swcPluginPath,
            cacheRoot,
            String(workerId),
          ],
          { cwd: projectRoot }
        )
      )
    );
  }, 30_000);
});
