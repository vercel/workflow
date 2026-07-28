import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_HEADERS_TIMEOUT_MS,
  getAgentOptions,
  getDispatcher,
  MAX_RETRIES,
  RETRY_ERROR_CODES,
} from './http-client.js';

describe('getDispatcher', () => {
  it('returns the shared default dispatcher when none is provided', () => {
    expect(getDispatcher()).toBe(getDispatcher());
    expect(getDispatcher({})).toBe(getDispatcher());
  });

  it('returns the caller-supplied dispatcher when provided', () => {
    const custom = {};
    expect(getDispatcher({ dispatcher: custom })).toBe(custom);
  });
});

describe('getAgentOptions', () => {
  const envKeys = [
    'WORKFLOW_VERCEL_HEADERS_TIMEOUT_MS',
    'WORKFLOW_VERCEL_BODY_TIMEOUT_MS',
  ] as const;

  afterEach(() => {
    for (const key of envKeys) delete process.env[key];
  });

  it('bounds requests below undici’s 5-minute defaults', () => {
    const { headersTimeout, bodyTimeout } = getAgentOptions();
    expect(headersTimeout).toBe(DEFAULT_HEADERS_TIMEOUT_MS);
    expect(bodyTimeout).toBe(DEFAULT_BODY_TIMEOUT_MS);
    // The point of the change: a stalled socket must surface long before the
    // queue's 300s visibility timeout lets the message redeliver, and before
    // makeRequest's own 60s deadline turns it into an opaque abort.
    for (const timeout of [headersTimeout, bodyTimeout]) {
      expect(timeout).toBeLessThan(60_000);
    }
  });

  it('honors environment overrides, including 0 (disabled)', () => {
    process.env.WORKFLOW_VERCEL_HEADERS_TIMEOUT_MS = '1234';
    process.env.WORKFLOW_VERCEL_BODY_TIMEOUT_MS = '0';
    expect(getAgentOptions().headersTimeout).toBe(1234);
    expect(getAgentOptions().bodyTimeout).toBe(0);
  });

  it('falls back to the default for unparseable or negative overrides', () => {
    process.env.WORKFLOW_VERCEL_HEADERS_TIMEOUT_MS = 'not-a-number';
    process.env.WORKFLOW_VERCEL_BODY_TIMEOUT_MS = '-1';
    expect(getAgentOptions().headersTimeout).toBe(DEFAULT_HEADERS_TIMEOUT_MS);
    expect(getAgentOptions().bodyTimeout).toBe(DEFAULT_BODY_TIMEOUT_MS);
  });
});

describe('retry options', () => {
  it('retries transport timeouts', () => {
    // undici's default errorCodes omit these, so a socket that accepted the
    // request and then went quiet was never retried.
    expect(RETRY_ERROR_CODES).toContain('UND_ERR_HEADERS_TIMEOUT');
    expect(RETRY_ERROR_CODES).toContain('UND_ERR_BODY_TIMEOUT');
  });

  it('keeps the worst-case retry budget inside the queue visibility window', () => {
    const attempts = MAX_RETRIES + 1;
    const { headersTimeout } = getAgentOptions();
    // Each attempt can burn a full headers timeout. The queue client wraps its
    // acknowledge call in its own 3 attempts, so the product must stay under
    // the 300s visibility timeout or a hung ack still loses the lease.
    expect(attempts * headersTimeout * 3).toBeLessThan(300_000);
  });
});

describe('a stalled response', () => {
  let server: Server | undefined;

  afterEach(async () => {
    delete process.env.WORKFLOW_VERCEL_HEADERS_TIMEOUT_MS;
    if (server) {
      const toClose = server;
      server = undefined;
      await new Promise((resolve) => toClose.close(resolve));
    }
  });

  it('fails with UND_ERR_HEADERS_TIMEOUT instead of hanging', async () => {
    // Accepts the request and never responds — the shape of the production
    // failure (the request was written, the invocation then waited).
    server = createServer(() => {});
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    process.env.WORKFLOW_VERCEL_HEADERS_TIMEOUT_MS = '150';
    const agent = new Agent(getAgentOptions());
    try {
      const started = Date.now();
      await expect(
        agent.request({
          origin: `http://127.0.0.1:${port}`,
          path: '/',
          method: 'GET',
        })
      ).rejects.toMatchObject({ code: 'UND_ERR_HEADERS_TIMEOUT' });
      // Well under undici's 300s default, which is what let the lease expire.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await agent.close();
    }
  });
});
