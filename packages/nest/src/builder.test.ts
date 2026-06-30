import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { join as pathJoin, resolve as pathResolve } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import { NestLocalBuilder, resolveNestBuilderConfig } from './builder.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-nest-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveNestBuilderConfig', () => {
  it('derives source, output, module, and project roots from framework config', () => {
    const repoRoot = createTempDir();
    const appRoot = join(repoRoot, 'apps/api');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeJson(join(appRoot, 'nest-cli.json'), { sourceRoot: 'lib' });
    writeJson(join(appRoot, 'tsconfig.json'), {
      compilerOptions: { outDir: 'build', module: 'NodeNext' },
    });
    writeJson(join(appRoot, '.swcrc'), { module: { type: 'commonjs' } });

    const workingDir = pathResolve(appRoot);
    expect(resolveNestBuilderConfig({ workingDir: appRoot })).toEqual({
      workingDir,
      outDir: pathJoin(appRoot, '.nestjs/workflow'),
      dirs: ['lib'],
      projectRoot: pathResolve(repoRoot),
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
      moduleType: 'es6',
      distDir: 'dist',
    });
  });

  it('passes derived dirs and projectRoot into the workflow builder config', () => {
    const repoRoot = createTempDir();
    const appRoot = join(repoRoot, 'apps/api');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeJson(join(appRoot, 'nest-cli.json'), { sourceRoot: 'lib' });

    const builder = new NestLocalBuilder({ workingDir: appRoot }) as any;

    expect(builder.config).toMatchObject({
      workingDir: pathResolve(appRoot),
      dirs: ['lib'],
      projectRoot: pathResolve(repoRoot),
    });
  });
});
