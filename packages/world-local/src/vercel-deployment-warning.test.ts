import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetVercelDeploymentWarning,
  warnIfRunningInVercelDeployment,
} from './build-target-mismatch.js';
import { createWorld } from './index.js';

/**
 * The target world is baked in at build time, so a build environment that does
 * not look like Vercel ships a deployment pinned to the local world. Creating
 * that world inside a deployment has to say so, because the filesystem writes
 * that follow fail without naming the world as the cause.
 */
describe('local world inside a Vercel deployment', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetVercelDeploymentWarning();
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
    resetVercelDeploymentWarning();
  });

  it('warns and names the build-time fix', () => {
    warnIfRunningInVercelDeployment('.next/workflow-data');

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('read-only');
    expect(message).toContain('WORKFLOW_TARGET_WORLD=vercel');
  });

  it('warns only once per process', () => {
    warnIfRunningInVercelDeployment('.next/workflow-data');
    warnIfRunningInVercelDeployment('.next/workflow-data');

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for the temp dir itself and for paths under it', () => {
    warnIfRunningInVercelDeployment(os.tmpdir());
    warnIfRunningInVercelDeployment(path.join(os.tmpdir(), 'workflow-data'));

    expect(warn).not.toHaveBeenCalled();
  });

  it('still warns for a sibling of the temp dir that merely shares its prefix', () => {
    warnIfRunningInVercelDeployment(`${os.tmpdir()}-elsewhere`);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays quiet outside a Vercel deployment', () => {
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', '');

    warnIfRunningInVercelDeployment('.workflow-data');

    expect(warn).not.toHaveBeenCalled();
  });

  it('is wired into createWorld, which passes its resolved data directory', () => {
    createWorld({ dataDir: '.next/workflow-data' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      path.resolve('.next/workflow-data')
    );
  });
});
