import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseCatalogEntries,
  rewriteDependencySpecs,
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
