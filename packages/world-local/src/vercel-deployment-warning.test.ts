import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The warning fires once per process, so each test needs a fresh module
 * registry rather than a shared import.
 */
async function importCreateWorld() {
  vi.resetModules();
  return (await import('./index.js')).createWorld;
}

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
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('warns and names the build-time fix', async () => {
    const createWorld = await importCreateWorld();
    createWorld({ dataDir: '.next/workflow-data' });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('read-only');
    expect(message).toContain('WORKFLOW_TARGET_WORLD=vercel');
  });

  it('stays quiet for a data directory under the writable temp dir', async () => {
    const createWorld = await importCreateWorld();
    createWorld({ dataDir: path.join(os.tmpdir(), 'workflow-data') });

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet outside a Vercel deployment', async () => {
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', '');
    const createWorld = await importCreateWorld();

    createWorld({ dataDir: '.workflow-data' });

    expect(warn).not.toHaveBeenCalled();
  });
});
