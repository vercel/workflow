import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import { findMissingSwcBuilderPackages } from './swc-builder-deps.js';

function installFake(appDir: string, pkg: string): void {
  const dir = join(appDir, 'node_modules', pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: pkg, version: '1.0.0', main: 'index.js' })
  );
  writeFileSync(join(dir, 'index.js'), '');
}

describe('findMissingSwcBuilderPackages', () => {
  let appDir: string;

  afterEach(() => {
    rmSync(appDir, { recursive: true, force: true });
  });

  function createApp(): string {
    appDir = mkdtempSync(join(tmpdir(), 'workflow-nest-swc-'));
    writeFileSync(join(appDir, 'package.json'), '{"name":"app"}');
    return appDir;
  }

  it('reports both packages when neither is installed', () => {
    expect(findMissingSwcBuilderPackages(createApp())).toEqual([
      '@swc/cli',
      '@swc/core',
    ]);
  });

  it('reports only @swc/cli when the app has @swc/core', () => {
    // `@swc/core` is a dependency of `@workflow/nest` and usually ends up
    // hoisted, while `@swc/cli` is only an optional peer.
    const dir = createApp();
    installFake(dir, '@swc/core');
    expect(findMissingSwcBuilderPackages(dir)).toEqual(['@swc/cli']);
  });

  it('reports nothing when both are installed', () => {
    const dir = createApp();
    installFake(dir, '@swc/cli');
    installFake(dir, '@swc/core');
    expect(findMissingSwcBuilderPackages(dir)).toEqual([]);
  });
});
