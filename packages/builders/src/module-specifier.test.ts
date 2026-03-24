import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearModuleSpecifierCache,
  getImportPath,
  resolveModuleSpecifier,
} from './module-specifier.js';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function writeFile(path: string, contents = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

describe('getImportPath', () => {
  let testRoot: string;

  beforeEach(() => {
    clearModuleSpecifierCache();
    testRoot = mkdtempSync(join(tmpdir(), 'workflow-module-specifier-'));
  });

  afterEach(() => {
    clearModuleSpecifierCache();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('uses package subpath import when file matches an export subpath', () => {
    const projectRoot = join(testRoot, 'apps/chat');
    const workspacePkgDir = join(testRoot, 'packages/agent');
    const filePath = join(workspacePkgDir, 'src/server.ts');

    writeJson(join(projectRoot, 'package.json'), {
      name: 'chat',
      dependencies: { '@internal/agent': 'workspace:*' },
    });

    writeJson(join(workspacePkgDir, 'package.json'), {
      name: '@internal/agent',
      version: '1.0.0',
      exports: {
        './server': './src/server.ts',
      },
    });

    writeFile(filePath, `'use step';\n`);

    expect(getImportPath(filePath, projectRoot)).toEqual({
      importPath: '@internal/agent/server',
      isPackage: true,
    });
  });

  it('falls back to relative import when package has no root export', () => {
    const projectRoot = join(testRoot, 'apps/chat');
    const workspacePkgDir = join(testRoot, 'packages/agent');
    const filePath = join(workspacePkgDir, 'src/server.ts');

    writeJson(join(projectRoot, 'package.json'), {
      name: 'chat',
      dependencies: { '@internal/agent': 'workspace:*' },
    });

    writeJson(join(workspacePkgDir, 'package.json'), {
      name: '@internal/agent',
      version: '1.0.0',
      exports: {
        './server': './dist/server.js',
      },
    });

    writeFile(filePath, `'use step';\n`);

    expect(getImportPath(filePath, projectRoot)).toEqual({
      importPath: '../../packages/agent/src/server.ts',
      isPackage: false,
    });
  });

  it('uses package root import for root exports', () => {
    const projectRoot = join(testRoot, 'apps/chat');
    const workspacePkgDir = join(testRoot, 'packages/agent');
    const filePath = join(workspacePkgDir, 'src/index.ts');

    writeJson(join(projectRoot, 'package.json'), {
      name: 'chat',
      dependencies: { '@internal/agent': 'workspace:*' },
    });

    writeJson(join(workspacePkgDir, 'package.json'), {
      name: '@internal/agent',
      version: '1.0.0',
      exports: {
        '.': './src/index.ts',
      },
    });

    writeFile(filePath, `'use workflow';\n`);

    expect(getImportPath(filePath, projectRoot)).toEqual({
      importPath: '@internal/agent',
      isPackage: true,
    });
  });

  it('uses package root import when package module points to file', () => {
    const projectRoot = join(testRoot, 'apps/chat');
    const workspacePkgDir = join(testRoot, 'packages/agent');
    const filePath = join(workspacePkgDir, 'src/index.mjs');

    writeJson(join(projectRoot, 'package.json'), {
      name: 'chat',
      dependencies: { '@internal/agent': 'workspace:*' },
    });

    writeJson(join(workspacePkgDir, 'package.json'), {
      name: '@internal/agent',
      version: '1.0.0',
      module: './src/index.mjs',
      main: './dist/index.cjs',
    });

    writeFile(filePath, `'use workflow';\n`);

    expect(getImportPath(filePath, projectRoot)).toEqual({
      importPath: '@internal/agent',
      isPackage: true,
    });
  });

  it('uses package root import for conditional root exports', () => {
    const projectRoot = join(testRoot, 'apps/chat');
    const workspacePkgDir = join(testRoot, 'packages/agent');
    const filePath = join(workspacePkgDir, 'src/index.js');

    writeJson(join(projectRoot, 'package.json'), {
      name: 'chat',
      dependencies: { '@internal/agent': 'workspace:*' },
    });

    writeJson(join(workspacePkgDir, 'package.json'), {
      name: '@internal/agent',
      version: '1.0.0',
      exports: {
        '.': {
          import: './src/index.mjs',
          default: './src/index.js',
        },
      },
    });

    writeFile(filePath, `'use workflow';\n`);

    expect(getImportPath(filePath, projectRoot)).toEqual({
      importPath: '@internal/agent',
      isPackage: true,
    });
  });

  it('falls back to relative import for deep files in packages without exports', () => {
    const projectRoot = join(testRoot, 'apps/chat');
    const workspacePkgDir = join(testRoot, 'packages/agent');
    const filePath = join(workspacePkgDir, 'lib/tools/dynamic/workflow.ts');

    writeJson(join(projectRoot, 'package.json'), {
      name: 'chat',
      dependencies: { '@internal/agent': 'workspace:*' },
    });

    writeJson(join(workspacePkgDir, 'package.json'), {
      name: '@internal/agent',
      version: '1.0.0',
    });

    writeFile(filePath, `'use workflow';\n`);

    expect(getImportPath(filePath, projectRoot)).toEqual({
      importPath: '../../packages/agent/lib/tools/dynamic/workflow.ts',
      isPackage: false,
    });
  });

  it('uses package root import when package main points to file', () => {
    const projectRoot = join(testRoot, 'apps/chat');
    const workspacePkgDir = join(testRoot, 'packages/agent');
    const filePath = join(workspacePkgDir, 'src/index.ts');

    writeJson(join(projectRoot, 'package.json'), {
      name: 'chat',
      dependencies: { '@internal/agent': 'workspace:*' },
    });

    writeJson(join(workspacePkgDir, 'package.json'), {
      name: '@internal/agent',
      version: '1.0.0',
      main: './src/index.ts',
    });

    writeFile(filePath, `'use step';\n`);

    expect(getImportPath(filePath, projectRoot)).toEqual({
      importPath: '@internal/agent',
      isPackage: true,
    });
  });

  it('uses package subpath import for direct node_modules dependencies', () => {
    const projectRoot = join(testRoot, 'apps/chat');
    const packageDir = join(testRoot, 'apps/chat/node_modules/@workflow/core');
    const filePath = join(packageDir, 'dist/serialization.js');

    writeJson(join(projectRoot, 'package.json'), {
      name: 'chat',
      dependencies: { '@workflow/core': '1.0.0' },
    });

    writeJson(join(packageDir, 'package.json'), {
      name: '@workflow/core',
      version: '1.0.0',
      exports: {
        './serialization': './dist/serialization.js',
      },
    });

    writeFile(filePath, `'use workflow';\n`);

    expect(getImportPath(filePath, projectRoot)).toEqual({
      importPath: '@workflow/core/serialization',
      isPackage: true,
    });
  });

  it('falls back to relative import for transitive node_modules dependencies', () => {
    const projectRoot = join(testRoot, 'apps/chat');
    const packageDir = join(testRoot, 'apps/chat/node_modules/@workflow/core');
    const filePath = join(packageDir, 'dist/serialization.js');

    writeJson(join(projectRoot, 'package.json'), {
      name: 'chat',
      dependencies: { workflow: '1.0.0' },
    });

    writeJson(join(packageDir, 'package.json'), {
      name: '@workflow/core',
      version: '1.0.0',
      exports: {
        './serialization': './dist/serialization.js',
      },
    });

    writeFile(filePath, `'use workflow';\n`);

    expect(getImportPath(filePath, projectRoot)).toEqual({
      importPath: './node_modules/@workflow/core/dist/serialization.js',
      isPackage: false,
    });
  });

  it('treats a workspace package file as local when projectRoot is the package itself', () => {
    const projectRoot = join(testRoot, 'packages/vade');
    const filePath = join(
      projectRoot,
      'src/internal/message/workflow/handle-message.ts'
    );

    writeJson(join(projectRoot, 'package.json'), {
      name: 'vade',
      version: '0.0.0',
    });

    writeFile(filePath, `'use workflow';\n`);

    expect(resolveModuleSpecifier(filePath, projectRoot)).toEqual({
      moduleSpecifier: undefined,
    });
  });

  it('uses the consuming app root to resolve workspace package workflow ids', () => {
    const projectRoot = join(testRoot, 'apps/chat');
    const packageDir = join(testRoot, 'packages/vade');
    const filePath = join(
      packageDir,
      'src/internal/message/workflow/handle-message.ts'
    );

    writeJson(join(projectRoot, 'package.json'), {
      name: 'chat',
      dependencies: { vade: 'workspace:*' },
    });

    writeJson(join(packageDir, 'package.json'), {
      name: 'vade',
      version: '0.0.0',
    });

    writeFile(filePath, `'use workflow';\n`);

    expect(resolveModuleSpecifier(filePath, projectRoot)).toEqual({
      moduleSpecifier: 'vade@0.0.0',
    });
  });
});
