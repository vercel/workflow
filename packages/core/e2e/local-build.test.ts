import { exec as execOriginal } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { usesVercelWorld } from '../../utils/src/world-target';
import { getWorkbenchAppPath } from './utils';

const exec = promisify(execOriginal);

describe.each([
  'nextjs-webpack',
  'nextjs-turbopack',
  'nitro',
  'vite',
  'sveltekit',
  'nuxt',
  'hono',
  'express',
  'fastify',
  'nest',
  'astro',
])('e2e', (project) => {
  test('builds without errors', { timeout: 180_000 }, async () => {
    // skip if we're targeting specific app to test
    if (process.env.APP_NAME && project !== process.env.APP_NAME) {
      return;
    }

    const result = await exec('pnpm build', {
      cwd: getWorkbenchAppPath(project),
    });

    expect(result.stderr).not.toContain('Error:');

    if (usesVercelWorld()) {
      const diagnosticsManifestPath = path.join(
        getWorkbenchAppPath(project),
        '.vercel/output/diagnostics/workflows-manifest.json'
      );
      await fs.access(diagnosticsManifestPath);
    }
  });
});
