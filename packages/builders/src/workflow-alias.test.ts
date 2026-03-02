import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearWorkflowAliasResolutionCache,
  resolveWorkflowAliasRelativePath,
} from './workflow-alias.js';

function writeFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "'use workflow';\n", 'utf-8');
}

describe('resolveWorkflowAliasRelativePath', () => {
  let testRoot: string;
  let workingDir: string;

  beforeEach(() => {
    clearWorkflowAliasResolutionCache();
    testRoot = mkdtempSync(join(tmpdir(), 'workflow-alias-'));
    workingDir = join(testRoot, 'app');
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    clearWorkflowAliasResolutionCache();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('maps files in workflows/ to workflows/* aliases', async () => {
    const filePath = join(workingDir, 'workflows', 'foo.ts');
    writeFile(filePath);

    await expect(
      resolveWorkflowAliasRelativePath(filePath, workingDir)
    ).resolves.toBe('workflows/foo.ts');
  });

  it('maps files in src/workflows/ to src/workflows/* aliases', async () => {
    const filePath = join(workingDir, 'src', 'workflows', 'foo.ts');
    writeFile(filePath);

    await expect(
      resolveWorkflowAliasRelativePath(filePath, workingDir)
    ).resolves.toBe('src/workflows/foo.ts');
  });

  it('returns undefined for files that are not under workflows paths', async () => {
    const filePath = join(workingDir, 'lib', 'foo.ts');
    writeFile(filePath);

    await expect(
      resolveWorkflowAliasRelativePath(filePath, workingDir)
    ).resolves.toBeUndefined();
  });

  it('returns undefined when basename matches but realpath differs', async () => {
    const workflowFilePath = join(workingDir, 'workflows', 'foo.ts');
    const externalFilePath = join(testRoot, 'external', 'workflows', 'foo.ts');
    writeFile(workflowFilePath);
    writeFile(externalFilePath);

    await expect(
      resolveWorkflowAliasRelativePath(externalFilePath, workingDir)
    ).resolves.toBeUndefined();
  });
});
