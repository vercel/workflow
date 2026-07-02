import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { join as pathJoin, resolve as pathResolve } from 'pathe';
import { describe, expect, it, onTestFinished } from 'vitest';
import { resolveNestBuilderConfig } from './builder.js';

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-nest-config-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('resolveNestBuilderConfig', () => {
  it('derives roots and build options from Nest, TypeScript, and SWC config', () => {
    const repoRoot = createTempDir();
    const appRoot = join(repoRoot, 'apps/api');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeJson(join(appRoot, 'nest-cli.json'), { sourceRoot: 'lib' });
    writeFileSync(
      join(appRoot, 'tsconfig.json'),
      '{\n  // tsconfig allows comments\n  "compilerOptions": { "outDir": "build", "module": "NodeNext" }\n}\n'
    );
    writeJson(join(appRoot, '.swcrc'), { module: { type: 'commonjs' } });

    const workingDir = pathResolve(appRoot);
    expect(resolveNestBuilderConfig({ workingDir: appRoot })).toEqual({
      workingDir,
      outDir: pathJoin(appRoot, '.nestjs/workflow'),
      dirs: ['lib'],
      projectRoot: pathResolve(repoRoot),
      moduleSpecifierRoot: workingDir,
      moduleType: 'commonjs',
      distDir: 'build',
    });
  });

  it('falls back to existing defaults without framework config files', () => {
    const appRoot = createTempDir();

    const workingDir = pathResolve(appRoot);
    expect(resolveNestBuilderConfig({ workingDir: appRoot })).toEqual({
      workingDir,
      outDir: pathJoin(appRoot, '.nestjs/workflow'),
      dirs: ['src'],
      projectRoot: workingDir,
      moduleSpecifierRoot: workingDir,
      moduleType: 'es6',
      distDir: 'dist',
    });
  });
});
