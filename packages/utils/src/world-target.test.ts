import { describe, expect, test } from 'vitest';
import {
  isVercelWorldTarget,
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
