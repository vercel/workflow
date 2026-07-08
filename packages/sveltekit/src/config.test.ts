import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSvelteKitConfig } from './builder.js';

describe('loadSvelteKitConfig', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads routes and base path from a TypeScript config', async () => {
    const root = mkdtempSync(
      join(dirname(fileURLToPath(import.meta.url)), 'config-test-')
    );
    roots.push(root);
    const routesDir = join(root, 'src/routes');
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(
      join(root, 'svelte.config.ts'),
      `export default { kit: { files: { routes: ${JSON.stringify(routesDir)} }, paths: { base: '/app' } } };`
    );

    await expect(loadSvelteKitConfig(root)).resolves.toEqual({
      basePath: '/app',
      routesDir,
    });
  });
});
