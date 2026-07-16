import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureWorkflowTargetWorldEnv,
  getWorldImport,
  isWorkflowTargetWorldPath,
  normalizeWorkflowTargetWorldImport,
  resolveWorkflowCoreRuntimeAlias,
  resolveWorkflowTargetWorldAlias,
  WORKFLOW_CORE_RUNTIME_MODULE,
  WORKFLOW_WORLD_TARGET_MODULE,
} from './world-target.js';

describe('workflow world target', () => {
  it('normalizes built-in aliases to package specifiers', () => {
    expect(normalizeWorkflowTargetWorldImport('local')).toBe(
      '@workflow/world-local'
    );
    expect(normalizeWorkflowTargetWorldImport('vercel')).toBe(
      '@workflow/world-vercel'
    );
    expect(normalizeWorkflowTargetWorldImport('@workflow/world-postgres')).toBe(
      '@workflow/world-postgres'
    );
  });

  it('defaults to local outside Vercel', () => {
    expect(getWorldImport({})).toBe('@workflow/world-local');
  });

  it('defaults to Vercel when deployed on Vercel', () => {
    expect(
      getWorldImport({
        VERCEL_DEPLOYMENT_ID: 'dpl_123',
      })
    ).toBe('@workflow/world-vercel');
  });

  it('writes the normalized target back to the env object', () => {
    const env = { WORKFLOW_TARGET_WORLD: 'local' };

    expect(ensureWorkflowTargetWorldEnv(env)).toBe('@workflow/world-local');
    expect(env.WORKFLOW_TARGET_WORLD).toBe('@workflow/world-local');
  });

  it('resolves package aliases to concrete module paths', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'workflow-world-target-'));
    const packageDir = join(testDir, 'node_modules/@workflow/world-custom');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@workflow/world-custom',
        type: 'module',
        exports: './index.js',
      })
    );
    writeFileSync(
      join(packageDir, 'index.js'),
      'export function createWorld() {}'
    );

    const alias = resolveWorkflowTargetWorldAlias({
      workingDir: testDir,
      targetWorld: '@workflow/world-custom',
    });

    try {
      expect(alias.replace(/\\/g, '/')).toMatch(
        /node_modules\/@workflow\/world-custom\/index\.js$/
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('resolves relative module files from the working directory', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'workflow-world-target-'));
    const worldFile = join(testDir, 'my-world.ts');
    writeFileSync(worldFile, 'export function createWorld() {}');

    const alias = resolveWorkflowTargetWorldAlias({
      workingDir: testDir,
      targetWorld: './my-world.ts',
    });

    try {
      expect(alias).toBe(realpathSync(worldFile));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('detects path-like target worlds', () => {
    expect(isWorkflowTargetWorldPath('./my-world.ts')).toBe(true);
    expect(isWorkflowTargetWorldPath('../my-world.ts')).toBe(true);
    expect(isWorkflowTargetWorldPath('/tmp/my-world.ts')).toBe(true);
    expect(isWorkflowTargetWorldPath('C:\\repo\\my-world.ts')).toBe(true);
    expect(isWorkflowTargetWorldPath('@workflow/world-postgres')).toBe(false);
  });

  it('keeps unresolved custom aliases externalizable', () => {
    expect(
      resolveWorkflowTargetWorldAlias({
        workingDir: process.cwd(),
        targetWorld: '@workflow/world-custom',
      })
    ).toBe('@workflow/world-custom');
  });

  it('resolves built-in worlds from the builder package when the app omits them', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'workflow-world-target-'));

    try {
      const alias = resolveWorkflowTargetWorldAlias({
        workingDir: testDir,
        targetWorld: '@workflow/world-local',
      });

      expect(alias.replace(/\\/g, '/')).toMatch(
        /packages\/world-local\/dist\/index\.js$/
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('uses the core target module as the alias key', () => {
    expect(WORKFLOW_WORLD_TARGET_MODULE).toBe(
      '@workflow/core/runtime/world-target'
    );
  });

  it('resolves the core runtime module from the builder package when the app omits it', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'workflow-world-target-'));

    try {
      const alias = resolveWorkflowCoreRuntimeAlias({
        workingDir: testDir,
      });

      expect(alias.replace(/\\/g, '/')).toMatch(
        /packages\/core\/dist\/runtime\.js$/
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('uses the core runtime module as the runtime alias key', () => {
    expect(WORKFLOW_CORE_RUNTIME_MODULE).toBe('@workflow/core/runtime');
  });
});
