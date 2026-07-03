import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSvelteKitBasePath } from './config.js';

describe('loadSvelteKitBasePath', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads and normalizes kit.paths.base from svelte config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-sveltekit-base-'));
    roots.push(root);
    writeFileSync(
      join(root, 'svelte.config.mjs'),
      'export default { kit: { paths: { base: "/app/" } } };'
    );

    await expect(loadSvelteKitBasePath(root)).resolves.toBe('/app');
  });
});
