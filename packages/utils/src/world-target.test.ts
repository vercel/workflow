import { describe, expect, test } from 'vitest';
import {
  getWorldImport,
  isVercelWorldTarget,
  normalizeWorkflowTargetWorldImport,
  resolveWorkflowTargetWorld,
  usesVercelWorld,
} from './world-target.js';

describe('resolveWorkflowTargetWorld', () => {
  test('returns configured world when WORKFLOW_TARGET_WORLD is set', () => {
    expect(
      resolveWorkflowTargetWorld({
        WORKFLOW_TARGET_WORLD: '@workflow/world-postgres',
        VERCEL_DEPLOYMENT_ID: 'deployment-id',
      })
    ).toBe('@workflow/world-postgres');
  });

  test('defaults to vercel when VERCEL_DEPLOYMENT_ID is set', () => {
    expect(
      resolveWorkflowTargetWorld({
        VERCEL_DEPLOYMENT_ID: 'deployment-id',
      })
    ).toBe('vercel');
  });

  test('defaults to local when no world env vars are set', () => {
    expect(resolveWorkflowTargetWorld({})).toBe('local');
  });
});

describe('getWorldImport', () => {
  test('returns configured custom world import when WORKFLOW_TARGET_WORLD is set', () => {
    expect(
      getWorldImport({
        WORKFLOW_TARGET_WORLD: '@workflow/world-postgres',
        VERCEL_DEPLOYMENT_ID: 'deployment-id',
      })
    ).toBe('@workflow/world-postgres');
  });

  test('normalizes built-in aliases to import specifiers', () => {
    expect(normalizeWorkflowTargetWorldImport('local')).toBe(
      '@workflow/world-local'
    );
    expect(normalizeWorkflowTargetWorldImport('vercel')).toBe(
      '@workflow/world-vercel'
    );
  });

  test('defaults to Vercel import when VERCEL_DEPLOYMENT_ID is set', () => {
    expect(
      getWorldImport({
        VERCEL_DEPLOYMENT_ID: 'deployment-id',
      })
    ).toBe('@workflow/world-vercel');
  });

  test('defaults to local import when no world env vars are set', () => {
    expect(getWorldImport({})).toBe('@workflow/world-local');
  });
});

describe('isVercelWorldTarget', () => {
  test('matches vercel world targets', () => {
    expect(isVercelWorldTarget('vercel')).toBe(true);
    expect(isVercelWorldTarget('@workflow/world-vercel')).toBe(true);
  });

  test('does not match non-vercel worlds', () => {
    expect(isVercelWorldTarget('local')).toBe(false);
    expect(isVercelWorldTarget('@workflow/world-postgres')).toBe(false);
  });
});

describe('usesVercelWorld', () => {
  test('returns true for resolved vercel world', () => {
    expect(
      usesVercelWorld({
        VERCEL_DEPLOYMENT_ID: 'deployment-id',
      })
    ).toBe(true);
  });

  test('returns false for resolved local world', () => {
    expect(usesVercelWorld({})).toBe(false);
  });
});
