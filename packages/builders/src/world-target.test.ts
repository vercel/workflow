import { describe, expect, it } from 'vitest';
import {
  ensureWorkflowTargetWorldEnv,
  getWorldImport,
  normalizeWorkflowTargetWorld,
  resolveWorkflowTargetWorldSpecifier,
  WORKFLOW_WORLD_TARGET_MODULE,
} from './world-target.js';

describe('workflow world target', () => {
  it('normalizes built-in aliases to package specifiers', () => {
    expect(normalizeWorkflowTargetWorld('local')).toBe('@workflow/world-local');
    expect(normalizeWorkflowTargetWorld('vercel')).toBe(
      '@workflow/world-vercel'
    );
    expect(normalizeWorkflowTargetWorld('@workflow/world-postgres')).toBe(
      '@workflow/world-postgres'
    );
  });

  it('defaults to local outside Vercel', () => {
    expect(getWorldImport({})).toBe('@workflow/world-local');
    expect(resolveWorkflowTargetWorldSpecifier({})).toBe(
      '@workflow/world-local'
    );
  });

  it('defaults to Vercel when deployed on Vercel', () => {
    expect(
      getWorldImport({
        VERCEL_DEPLOYMENT_ID: 'dpl_123',
      })
    ).toBe('@workflow/world-vercel');
    expect(
      resolveWorkflowTargetWorldSpecifier({
        VERCEL_DEPLOYMENT_ID: 'dpl_123',
      })
    ).toBe('@workflow/world-vercel');
  });

  it('writes the normalized target back to the env object', () => {
    const env = { WORKFLOW_TARGET_WORLD: 'local' };

    expect(ensureWorkflowTargetWorldEnv(env)).toBe('@workflow/world-local');
    expect(env.WORKFLOW_TARGET_WORLD).toBe('@workflow/world-local');
  });

  it('uses the core target module as the alias key', () => {
    expect(WORKFLOW_WORLD_TARGET_MODULE).toBe(
      '@workflow/core/runtime/world-target'
    );
  });
});
