import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  getDecoratorOptionsFromTsConfig,
  resolveProjectRoot,
} from './config-helpers.js';

describe('resolveProjectRoot', () => {
  it('prefers the workspace root over app lockfiles', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'workflow-project-root-'));
    onTestFinished(() => rmSync(repoRoot, { recursive: true, force: true }));

    const appRoot = join(repoRoot, 'apps/web');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(appRoot, 'package-lock.json'), '{}\n');

    expect(resolveProjectRoot(appRoot)).toBe(repoRoot);
  });
});

describe('getDecoratorOptionsFromTsConfig', () => {
  const enabled = {
    decorators: true,
    legacyDecorator: true,
    decoratorMetadata: true,
  };
  const disabled = {
    decorators: false,
    legacyDecorator: false,
    decoratorMetadata: false,
  };

  function makeProject(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-decorators-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    for (const [file, content] of Object.entries(files)) {
      const target = join(dir, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        typeof content === 'string' ? content : JSON.stringify(content)
      );
    }
    return dir;
  }

  const decoratorOptions = {
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
  };

  it('reads options declared in the tsconfig itself', async () => {
    const dir = makeProject({
      'tsconfig.json': { compilerOptions: decoratorOptions },
    });
    await expect(
      getDecoratorOptionsFromTsConfig(join(dir, 'tsconfig.json'))
    ).resolves.toEqual(enabled);
  });

  it('reads options from a relative extends base', async () => {
    const dir = makeProject({
      'tsconfig.base.json': { compilerOptions: decoratorOptions },
      'tsconfig.json': { extends: './tsconfig.base.json' },
    });
    await expect(
      getDecoratorOptionsFromTsConfig(join(dir, 'tsconfig.json'))
    ).resolves.toEqual(enabled);
  });

  it('follows a chain of extends', async () => {
    const dir = makeProject({
      'configs/root.json': { compilerOptions: decoratorOptions },
      'configs/middle.json': { extends: './root.json' },
      'tsconfig.json': { extends: './configs/middle.json' },
    });
    await expect(
      getDecoratorOptionsFromTsConfig(join(dir, 'tsconfig.json'))
    ).resolves.toEqual(enabled);
  });

  it('lets the last entry of an extends array win', async () => {
    const dir = makeProject({
      'on.json': { compilerOptions: decoratorOptions },
      'off.json': {
        compilerOptions: {
          experimentalDecorators: false,
          emitDecoratorMetadata: false,
        },
      },
      'tsconfig.json': { extends: ['./off.json', './on.json'] },
      'tsconfig.reversed.json': { extends: ['./on.json', './off.json'] },
    });
    await expect(
      getDecoratorOptionsFromTsConfig(join(dir, 'tsconfig.json'))
    ).resolves.toEqual(enabled);
    await expect(
      getDecoratorOptionsFromTsConfig(join(dir, 'tsconfig.reversed.json'))
    ).resolves.toEqual(disabled);
  });

  it('lets the child compilerOptions override the base', async () => {
    const dir = makeProject({
      'tsconfig.base.json': { compilerOptions: decoratorOptions },
      'tsconfig.json': {
        extends: './tsconfig.base.json',
        compilerOptions: { emitDecoratorMetadata: false },
      },
    });
    await expect(
      getDecoratorOptionsFromTsConfig(join(dir, 'tsconfig.json'))
    ).resolves.toEqual({
      decorators: true,
      legacyDecorator: true,
      decoratorMetadata: false,
    });
  });

  it('resolves a package specifier extends from node_modules', async () => {
    const dir = makeProject({
      'node_modules/@repo/typescript-config/package.json': {
        name: '@repo/typescript-config',
        version: '0.0.0',
      },
      'node_modules/@repo/typescript-config/nest.json': {
        compilerOptions: decoratorOptions,
      },
      'tsconfig.json': { extends: '@repo/typescript-config/nest.json' },
    });
    await expect(
      getDecoratorOptionsFromTsConfig(join(dir, 'tsconfig.json'))
    ).resolves.toEqual(enabled);
  });

  it('stops on a circular extends instead of looping', async () => {
    const dir = makeProject({
      'a.json': { extends: './b.json', compilerOptions: decoratorOptions },
      'b.json': { extends: './a.json' },
      'tsconfig.json': { extends: './a.json' },
    });
    await expect(
      getDecoratorOptionsFromTsConfig(join(dir, 'tsconfig.json'))
    ).resolves.toEqual(enabled);
  });
});
