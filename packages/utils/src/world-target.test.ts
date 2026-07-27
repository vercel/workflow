import { describe, expect, test } from 'vitest';
import {
  isVercelDeploymentEnv,
  isVercelWorldTarget,
  resolveWorkflowTargetWorld,
  usesVercelWorld,
} from './world-target.js';

/**
 * Environment of a `vercel build` run outside Vercel's own build container,
 * as produced by `vercel pull`: no deployment exists yet, so there is no
 * deployment ID to key off.
 */
const PREBUILT_BUILD_ENV = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  VERCEL_TARGET_ENV: 'production',
  VERCEL_URL: 'example.vercel.app',
  NODE_ENV: 'production',
};

describe('isVercelDeploymentEnv', () => {
  test('detects a deployment from VERCEL_DEPLOYMENT_ID', () => {
    expect(isVercelDeploymentEnv({ VERCEL_DEPLOYMENT_ID: 'dpl_123' })).toBe(
      true
    );
  });

  test('detects a prebuilt build that has no deployment ID yet', () => {
    expect(isVercelDeploymentEnv(PREBUILT_BUILD_ENV)).toBe(true);
  });

  test('ignores VERCEL=1 leaking into a dev server via `vercel env pull`', () => {
    expect(
      isVercelDeploymentEnv({
        ...PREBUILT_BUILD_ENV,
        VERCEL_ENV: 'preview',
        NODE_ENV: 'development',
      })
    ).toBe(false);
  });

  test('detects a Vercel build that exposes no NODE_ENV', () => {
    // Processes outside a framework build/serve command (plain node scripts,
    // CLI contexts) leave NODE_ENV unset, so absence must not read as
    // development.
    const { NODE_ENV: _unset, ...envWithoutNodeEnv } = PREBUILT_BUILD_ENV;
    expect(isVercelDeploymentEnv(envWithoutNodeEnv)).toBe(true);
  });

  test('ignores `vercel dev`', () => {
    expect(
      isVercelDeploymentEnv({ VERCEL: '1', VERCEL_ENV: 'development' })
    ).toBe(false);
  });

  test('is false off Vercel', () => {
    expect(isVercelDeploymentEnv({ NODE_ENV: 'production' })).toBe(false);
  });
});

describe('resolveWorkflowTargetWorld', () => {
  test('resolves vercel for a prebuilt build with no deployment ID', () => {
    expect(resolveWorkflowTargetWorld(PREBUILT_BUILD_ENV)).toBe('vercel');
  });

  test('WORKFLOW_TARGET_WORLD still opts a Vercel build out to local', () => {
    expect(
      resolveWorkflowTargetWorld({
        ...PREBUILT_BUILD_ENV,
        WORKFLOW_TARGET_WORLD: 'local',
      })
    ).toBe('local');
  });

  test('resolves local for a dev server with pulled Vercel env', () => {
    expect(
      resolveWorkflowTargetWorld({
        ...PREBUILT_BUILD_ENV,
        NODE_ENV: 'development',
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
