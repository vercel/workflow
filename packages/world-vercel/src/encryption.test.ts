import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));
vi.stubGlobal('fetch', mockFetch);
vi.mock('./http-client.js', () => ({
  getDispatcher: vi.fn().mockReturnValue({}),
}));

import {
  createGetEncryptionKeyForRun,
  deriveRunKey,
  fetchRunKey,
} from './encryption.js';

const testProjectId = 'prj_test123';
const testRunId = 'wrun_abc123';
// 32 bytes for AES-256
const testDeploymentKey = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
  0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
  0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
]);

describe('deriveRunKey', () => {
  it('should derive a 32-byte key', async () => {
    const key = await deriveRunKey(testDeploymentKey, testProjectId, testRunId);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.byteLength).toBe(32);
  });

  it('should derive the same key for the same inputs', async () => {
    const key1 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      testRunId
    );
    const key2 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      testRunId
    );
    expect(key1).toEqual(key2);
  });

  it('should derive different keys for different runIds', async () => {
    const key1 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      'wrun_run1'
    );
    const key2 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      'wrun_run2'
    );
    expect(key1).not.toEqual(key2);
  });

  it('should derive different keys for different projectIds', async () => {
    const key1 = await deriveRunKey(
      testDeploymentKey,
      'prj_project1',
      testRunId
    );
    const key2 = await deriveRunKey(
      testDeploymentKey,
      'prj_project2',
      testRunId
    );
    expect(key1).not.toEqual(key2);
  });

  it('should derive different keys for different deployment keys', async () => {
    const otherKey = new Uint8Array(32);
    crypto.getRandomValues(otherKey);

    const key1 = await deriveRunKey(
      testDeploymentKey,
      testProjectId,
      testRunId
    );
    const key2 = await deriveRunKey(otherKey, testProjectId, testRunId);
    expect(key1).not.toEqual(key2);
  });

  it('should throw for invalid key length', async () => {
    await expect(
      deriveRunKey(new Uint8Array(16), testProjectId, testRunId)
    ).rejects.toThrow('expected 32 bytes for AES-256, got 16 bytes');
  });

  it('should throw for empty projectId', async () => {
    await expect(
      deriveRunKey(testDeploymentKey, '', testRunId)
    ).rejects.toThrow('projectId must be a non-empty string');
  });
});

describe('fetchRunKey', () => {
  const deploymentId = 'dpl_test123';

  afterEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  it('should return undefined when API returns null key', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: null }), { status: 200 })
    );

    const result = await fetchRunKey(deploymentId, testProjectId, testRunId, {
      token: 'test-token',
    });

    expect(result).toBeUndefined();
  });

  it('should return a Uint8Array when API returns a valid key', async () => {
    const keyBase64 = Buffer.from(testDeploymentKey).toString('base64');
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: keyBase64 }), { status: 200 })
    );

    const result = await fetchRunKey(deploymentId, testProjectId, testRunId, {
      token: 'test-token',
    });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(Buffer.from(keyBase64, 'base64'));
  });

  it('should throw on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not found', { status: 404 }));

    await expect(
      fetchRunKey(deploymentId, testProjectId, testRunId, {
        token: 'test-token',
      })
    ).rejects.toThrow('HTTP 404');
  });
});

describe('createGetEncryptionKeyForRun (runId, { deploymentId }) overload', () => {
  const projectId = 'prj_test123';
  const runId = 'wrun_xdeploy';
  const currentDeployment = 'dpl_A';
  const otherDeployment = 'dpl_B';

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      VERCEL: process.env.VERCEL,
      VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
      VERCEL_DEPLOYMENT_KEY: process.env.VERCEL_DEPLOYMENT_KEY,
    };
    // Serverless runtime with a local deployment key for the current deployment.
    process.env.VERCEL = '1';
    process.env.VERCEL_DEPLOYMENT_ID = currentDeployment;
    process.env.VERCEL_DEPLOYMENT_KEY =
      Buffer.from(testDeploymentKey).toString('base64');
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    mockFetch.mockReset();
  });

  it('derives locally and does not fetch when the context deployment is the current one', async () => {
    const getKey = createGetEncryptionKeyForRun(projectId, undefined, 'tok');
    if (!getKey) throw new Error('expected getEncryptionKeyForRun to exist');
    const key = await getKey(runId, { deploymentId: currentDeployment });

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key?.byteLength).toBe(32);
    expect(key).toEqual(
      await deriveRunKey(testDeploymentKey, projectId, runId)
    );
    // Same-deployment key work stays local — no cross-deployment API call.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches the run key for a different context deployment', async () => {
    const keyBase64 = Buffer.from(testDeploymentKey).toString('base64');
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: keyBase64 }), { status: 200 })
    );

    const getKey = createGetEncryptionKeyForRun(projectId, undefined, 'tok');
    if (!getKey) throw new Error('expected getEncryptionKeyForRun to exist');
    const key = await getKey(runId, { deploymentId: otherDeployment });

    expect(key).toEqual(Buffer.from(keyBase64, 'base64'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The fetch targets the OTHER deployment's run-key endpoint.
    const callArgs = JSON.stringify(mockFetch.mock.calls[0]);
    expect(callArgs).toContain(`run-key/${otherDeployment}`);
    expect(callArgs).not.toContain(`run-key/${currentDeployment}`);
  });
});
