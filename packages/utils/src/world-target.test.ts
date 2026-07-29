import { describe, expect, test } from 'vitest';
import {
  isVercelWorldTarget,
  resolveWorkflowTargetWorld,
  usesVercelWorld,
} from './world-target.js';

/**
 * Environment of a process that looks like Vercel without running inside a
 * deployment: a `vercel build` outside Vercel's own build container, or a
 * server started from an env file written by `vercel env pull`. The world is
 * resolved when the process starts, so only the deployment ID decides.
 */
const VERCEL_ENV_WITHOUT_DEPLOYMENT = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  VERCEL_TARGET_ENV: 'production',
  VERCEL_URL: 'example.vercel.app',
  NODE_ENV: 'production',
};

describe('resolveWorkflowTargetWorld', () => {
  test('resolves local when Vercel env is present but no deployment ID is', () => {
    expect(resolveWorkflowTargetWorld(VERCEL_ENV_WITHOUT_DEPLOYMENT)).toBe(
      'local'
    );
  });

  test('WORKFLOW_TARGET_WORLD opts such a process in to the Vercel world', () => {
    expect(
      resolveWorkflowTargetWorld({
        ...VERCEL_ENV_WITHOUT_DEPLOYMENT,
        WORKFLOW_TARGET_WORLD: 'vercel',
      })
    ).toBe('vercel');
  });

  test('WORKFLOW_TARGET_WORLD opts a deployment out to local', () => {
    expect(
      resolveWorkflowTargetWorld({
        VERCEL_DEPLOYMENT_ID: 'dpl_123',
        WORKFLOW_TARGET_WORLD: 'local',
      })
    ).toBe('local');
  });

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
