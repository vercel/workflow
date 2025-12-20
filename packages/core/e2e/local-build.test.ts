import { exec as execOriginal } from 'child_process';
import { promisify } from 'util';
import { describe, expect, test } from 'vitest';
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
  'astro',
])('e2e', (project) => {
  test('builds without errors', { timeout: 180_000 }, async () => {
    // skip if we're targeting specific app to test
    if (process.env.APP_NAME && project !== process.env.APP_NAME) {
      return;
    }

    const result = await exec('pnpm build', {
      cwd: getWorkbenchAppPath(project),
      timeout: 120_000,
    });

    console.log(result.stdout);
    console.log(result.stderr);

    expect(result.stderr).not.toContain('Error:');
  });
});
