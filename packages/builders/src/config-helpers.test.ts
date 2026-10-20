import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('reads decorator options from an extended tsconfig', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-tsconfig-extends-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));

    mkdirSync(join(root, 'apps/web'), { recursive: true });
    writeFileSync(
      join(root, 'tsconfig.base.json'),
      JSON.stringify({
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      })
    );
    writeFileSync(
      join(root, 'apps/web/tsconfig.json'),
      // `extends` without the `.json` extension, as TypeScript allows.
      JSON.stringify({ extends: '../../tsconfig.base' })
    );

    await expect(
      getDecoratorOptionsFromTsConfig(join(root, 'apps/web/tsconfig.json'))
    ).resolves.toEqual({
      decorators: true,
      legacyDecorator: true,
      decoratorMetadata: true,
    });
  });

  it('lets the extending tsconfig override the base', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-tsconfig-extends-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));

    writeFileSync(
      join(root, 'tsconfig.base.json'),
      JSON.stringify({
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      })
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        extends: ['./tsconfig.base.json'],
        compilerOptions: { emitDecoratorMetadata: false },
      })
    );

    await expect(
      getDecoratorOptionsFromTsConfig(join(root, 'tsconfig.json'))
    ).resolves.toEqual({
      decorators: true,
      legacyDecorator: true,
      decoratorMetadata: false,
    });
  });
});
