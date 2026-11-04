import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseCatalogEntries,
  rewriteDependencySpecs,
  stageLockfile,
} from './stage-workbench-with-tarballs.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('staged workbench catalog dependencies', () => {
  it('resolves default and named catalogs before leaving the workspace', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-catalog-test-')
    );
    temporaryDirectories.push(directory);

    const workspacePath = path.join(directory, 'pnpm-workspace.yaml');
    fs.writeFileSync(
      workspacePath,
      `packages:
  - .

catalog:
  zod: 4.3.6

catalogs:
  ai-sdk-v7:
    "@ai-sdk/workflow": 2.0.15
    ai: 7.0.85

overrides: {}
`
    );

    const packageJsonPath = path.join(directory, 'package.json');
    fs.writeFileSync(
      packageJsonPath,
      `${JSON.stringify(
        {
          dependencies: {
            '@ai-sdk/workflow': 'catalog:ai-sdk-v7',
            ai: 'catalog:ai-sdk-v7',
            zod: 'catalog:',
          },
        },
        null,
        2
      )}\n`
    );

    const catalogs = parseCatalogEntries(workspacePath);
    const result = rewriteDependencySpecs(packageJsonPath, new Map(), catalogs);

    expect(JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))).toEqual({
      dependencies: {
        '@ai-sdk/workflow': '2.0.15',
        ai: '7.0.85',
        zod: '4.3.6',
      },
    });
    expect(result.replacedCatalogEntries).toEqual([
      'dependencies.@ai-sdk/workflow',
      'dependencies.ai',
      'dependencies.zod',
    ]);
  });
});

describe('staged workbench lockfile', () => {
  const lockfile = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

overrides:
  devalue@^5: 5.9.2

importers:

  .:
    devDependencies:
      turbo:
        specifier: ^2.0.0
        version: 2.0.0

  workbench/app:
    dependencies:
      next:
        specifier: 16.0.0
        version: 16.0.0
      workflow:
        specifier: workspace:*
        version: link:../../packages/workflow

  workbench/other:
    dependencies:
      vite:
        specifier: ^7.0.0
        version: 7.0.0

packages:

  next@16.0.0:
    resolution: {integrity: sha512-next}

snapshots:

  next@16.0.0: {}
`;

  it('keeps only the workbench importer, as the staged root, and every locked package', () => {
    expect(
      stageLockfile(lockfile, 'workbench/app')
    ).toBe(`lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

overrides:
  devalue@^5: 5.9.2

importers:

  .:
    dependencies:
      next:
        specifier: 16.0.0
        version: 16.0.0
      workflow:
        specifier: workspace:*
        version: link:../../packages/workflow

packages:

  next@16.0.0:
    resolution: {integrity: sha512-next}

snapshots:

  next@16.0.0: {}
`);
  });

  it('keeps the last importer up to the packages section', () => {
    expect(stageLockfile(lockfile, 'workbench/other')).toContain(`importers:

  .:
    dependencies:
      vite:
        specifier: ^7.0.0
        version: 7.0.0

packages:`);
  });

  it('fails for a workbench the lockfile has no importer for', () => {
    expect(() => stageLockfile(lockfile, 'workbench/missing')).toThrow(
      /no importer for workbench\/missing/
    );
  });

  // The CI lanes stage these two; a lockfile without their importers would
  // silently fall back to resolving everything fresh.
  it.each([
    'workbench/nextjs-turbopack',
    'workbench/nextjs-webpack',
  ])('finds the %s importer in the repo lockfile', (importer) => {
    const repoLockfile = fs.readFileSync(
      fileURLToPath(new URL('../pnpm-lock.yaml', import.meta.url)),
      'utf8'
    );
    expect(stageLockfile(repoLockfile, importer)).toMatch(
      /\nimporters:\n\n {2}\.:\n {4}dependencies:/
    );
  });
});
