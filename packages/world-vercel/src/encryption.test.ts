import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));
vi.stubGlobal('fetch', mockFetch);
vi.mock('./http-client.js', () => ({
  getDispatcher: vi.fn().mockReturnValue({}),
}));
vi.mock('./get-deadline.js', () => ({
  getDeadline: vi.fn(async () => undefined),
}));

import {
  createGetEncryptionKeyForRun,
  deriveRunKey,
  fetchRunKey,
} from './encryption.js';
import { getDeadline } from './get-deadline.js';
import {
  getRunKeyRateLimit,
  RUN_KEY_RETRY_MAX_ATTEMPTS,
} from './run-key-retry.js';
import { trace } from './telemetry.js';

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
    ).rejects.toMatchObject({
      message: expect.stringContaining('HTTP 404'),
      status: 404,
    });
  });
});

describe('fetchRunKey 429 retry', () => {
  const deploymentId = 'dpl_test123';
  const NOW = Date.UTC(2026, 9, 14, 3, 0, 0);
  const keyBase64 = Buffer.from(testDeploymentKey).toString('base64');

  /** The run-key limiter's 429: Retry-After and X-RateLimit-Reset both point
   * one 60s window out, as the endpoint sends them. */
  function rateLimited(headers: Record<string, string> = {}): Response {
    return new Response(
      JSON.stringify({
        error: {
          code: 'rate_limited',
          message: 'Too many requests - try again in 1 minute',
        },
      }),
      {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'content-type': 'application/json',
          'retry-after': '60',
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.ceil((Date.now() + 60_000) / 1000)),
          ...headers,
        },
      }
    );
  }

  function ok(): Response {
    return new Response(JSON.stringify({ key: keyBase64 }), { status: 200 });
  }

  function fetchKey() {
    return fetchRunKey(deploymentId, testProjectId, testRunId, {
      token: 'test-token',
    });
  }

  beforeAll(async () => {
    // Complete the optional telemetry import before freezing the clock.
    await trace('run-key retry test setup', async () => {});
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.mocked(getDeadline).mockResolvedValue(undefined);
    // Midpoint jitter: a 60s Retry-After waits 60s + 0.5 * 15s.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  it('waits out Retry-After plus jitter, then succeeds', async () => {
    mockFetch.mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(ok());

    const result = fetchKey();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Never earlier than the server asked, and the jitter is on top of it.
    await vi.advanceTimersByTimeAsync(67_499);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(Buffer.from(keyBase64, 'base64'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    // Each attempt is a fresh request carrying the credentials.
    for (const [url, init] of mockFetch.mock.calls) {
      expect(url).toContain(`run-key/${deploymentId}`);
      expect(new Headers(init.headers).get('authorization')).toBe(
        'Bearer test-token'
      );
    }
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('retrying in 67.5s (attempt 2 of 4)')
    );
  });

  it.each([
    [
      'an HTTP-date Retry-After',
      () => ({ 'retry-after': new Date(NOW + 20_000).toUTCString() }),
      20_000,
    ],
    [
      'X-RateLimit-Reset when Retry-After is absent',
      () => ({
        'retry-after': '',
        'x-ratelimit-reset': String((NOW + 30_000) / 1000),
      }),
      30_000,
    ],
    [
      'a delta-seconds X-RateLimit-Reset',
      () => ({ 'retry-after': '', 'x-ratelimit-reset': '12' }),
      12_000,
    ],
    [
      'the fallback backoff when the 429 names no wait',
      () => ({ 'retry-after': '', 'x-ratelimit-reset': '' }),
      5_000,
    ],
  ])('honors %s', async (_label, headers, baseMs) => {
    mockFetch
      .mockImplementationOnce(async () => rateLimited(headers()))
      .mockResolvedValueOnce(ok());

    const result = fetchKey();
    await vi.advanceTimersByTimeAsync(baseMs - 1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(await result).toEqual(Buffer.from(keyBase64, 'base64'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Jitter is a quarter of the base wait, with a 1s floor.
    const jitterMs = 0.5 * Math.max(1_000, baseMs * 0.25);
    expect(Date.now() - NOW).toBe(Math.round(baseMs + jitterMs));
  });

  it('gives up with RunKeyFetchError(429) once a second 60s window no longer fits', async () => {
    mockFetch.mockImplementation(async () => rateLimited());

    const outcome = fetchKey().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await outcome;

    // One retry fits the 90s budget; a second 60s wait would not, so it is
    // not taken at all.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(Date.now() - NOW).toBe(67_500);
    expect(error).toMatchObject({
      name: 'RunKeyFetchError',
      status: 429,
      message: expect.stringContaining('HTTP 429'),
    });
    expect((error as Error).message).toContain('gave up after 2 attempts');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps the number of attempts when Retry-After is short', async () => {
    mockFetch.mockImplementation(async () =>
      rateLimited({ 'retry-after': '1' })
    );

    const outcome = fetchKey().catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(mockFetch).toHaveBeenCalledTimes(RUN_KEY_RETRY_MAX_ATTEMPTS);
    expect(await outcome).toMatchObject({
      status: 429,
      message: expect.stringContaining(
        `gave up after ${RUN_KEY_RETRY_MAX_ATTEMPTS} attempts`
      ),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces a Retry-After beyond the budget without waiting', async () => {
    mockFetch.mockImplementation(async () =>
      rateLimited({ 'retry-after': '3600' })
    );

    const outcome = fetchKey().catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(NOW);
    expect(await outcome).toMatchObject({
      status: 429,
      message: expect.stringContaining('gave up after 1 attempt and'),
    });
  });

  it("surfaces the 429 when the wait would run into the function's deadline", async () => {
    vi.mocked(getDeadline).mockResolvedValue(new Date(NOW + 45_000));
    mockFetch.mockImplementation(async () => rateLimited());

    const outcome = fetchKey().catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(NOW);
    expect(await outcome).toMatchObject({
      status: 429,
      message: expect.stringContaining("before the function's deadline"),
    });
  });

  it.each([
    'challenge',
    'deny',
  ])('does not retry a firewall 429 (x-vercel-mitigated: %s)', async (mitigated) => {
    mockFetch.mockImplementation(async () =>
      rateLimited({ 'x-vercel-mitigated': mitigated })
    );

    const outcome = fetchKey().catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(NOW);
    const error = await outcome;
    expect(error).toMatchObject({
      status: 429,
      message: expect.stringContaining(`x-vercel-mitigated=${mitigated}`),
    });
    expect((error as Error).message).not.toContain('gave up');
  });

  it.each([400, 401, 403, 404])('does not retry HTTP %i', async (status) => {
    mockFetch.mockImplementation(
      async () =>
        new Response('nope', { status, headers: { 'retry-after': '1' } })
    );

    const outcome = fetchKey().catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await outcome).toMatchObject({
      status,
      message: expect.stringContaining(`HTTP ${status}`),
    });
  });
});

describe('getRunKeyRateLimit', () => {
  const at = (status: number, headers: Record<string, string>) =>
    getRunKeyRateLimit({ status, headers: new Headers(headers) });

  it('only classifies a 429 without x-vercel-mitigated', () => {
    expect(at(429, { 'retry-after': '60' })).toEqual({ retryAfterMs: 60_000 });
    expect(at(429, {})).toEqual({ retryAfterMs: undefined });
    expect(
      at(429, { 'retry-after': '60', 'x-vercel-mitigated': 'challenge' })
    ).toBeUndefined();
    expect(at(503, { 'retry-after': '60' })).toBeUndefined();
  });

  it('prefers Retry-After over X-RateLimit-Reset and ignores junk', () => {
    expect(at(429, { 'retry-after': '5', 'x-ratelimit-reset': '30' })).toEqual({
      retryAfterMs: 5_000,
    });
    expect(
      at(429, { 'retry-after': 'soon', 'x-ratelimit-reset': 'x' })
    ).toEqual({ retryAfterMs: undefined });
    expect(at(429, { 'retry-after': '-3' })).toEqual({ retryAfterMs: 0 });
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
