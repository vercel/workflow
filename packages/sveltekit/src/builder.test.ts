import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { loadSvelteKitRoutesDir, SvelteKitBuilder } from './builder.js';

describe('SvelteKitBuilder config', () => {
  it('derives project root from the nearest workspace root', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'workflow-sveltekit-config-'));
    onTestFinished(() => rmSync(repoRoot, { recursive: true, force: true }));

    const appRoot = join(repoRoot, 'apps/web');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');

    const builder = new SvelteKitBuilder({ workingDir: appRoot }) as any;

    expect(builder.config).toMatchObject({
      workingDir: appRoot,
      projectRoot: repoRoot,
      moduleSpecifierRoot: appRoot,
    });
  });

  it('passes explicit workflow builder options through', () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'workflow-sveltekit-options-'));
    onTestFinished(() => rmSync(appRoot, { recursive: true, force: true }));

    const projectRoot = join(appRoot, '../repo');
    const moduleSpecifierRoot = join(appRoot, 'module-root');
    const dirs = ['custom/workflows', 'more-workflows'];
    const builder = new SvelteKitBuilder({
      workingDir: appRoot,
      dirs,
      projectRoot,
      moduleSpecifierRoot,
      sourcemap: false,
    }) as any;

    expect(builder.config).toMatchObject({
      workingDir: appRoot,
      dirs,
      projectRoot,
      moduleSpecifierRoot,
      sourcemap: false,
    });
  });

  it('uses an explicit routes directory override', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'workflow-sveltekit-options-'));
    onTestFinished(() => rmSync(appRoot, { recursive: true, force: true }));

    const routesDir = join(appRoot, 'app/custom/pages');
    mkdirSync(routesDir, { recursive: true });

    const builder = new SvelteKitBuilder({
      workingDir: appRoot,
      routesDir: 'app/custom/pages',
    }) as any;

    await expect(builder.loadRoutesDirectory()).resolves.toBe(routesDir);
  });

  it('loads the routes directory from SvelteKit config', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'workflow-sveltekit-routes-'));
    onTestFinished(() => rmSync(appRoot, { recursive: true, force: true }));

    const kitRoot = join(appRoot, 'node_modules/@sveltejs/kit');
    const routesDir = join(appRoot, 'app/custom/pages');
    mkdirSync(join(kitRoot, 'src/core/config'), { recursive: true });
    writeFileSync(join(appRoot, 'package.json'), '{}\n');
    writeFileSync(
      join(kitRoot, 'package.json'),
      JSON.stringify({ name: '@sveltejs/kit', type: 'module' })
    );
    writeFileSync(
      join(kitRoot, 'src/core/config/index.js'),
      `export async function load_config({ cwd }) {
  return { kit: { files: { routes: ${JSON.stringify(routesDir)} } } };
}
`
    );

    await expect(loadSvelteKitRoutesDir(appRoot)).resolves.toBe(routesDir);
  });
});
