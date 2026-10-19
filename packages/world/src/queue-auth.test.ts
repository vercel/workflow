import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyQueueAuthHeader,
  authorizeQueueDelivery,
  QUEUE_AUTH_HEADER,
  QUEUE_SECRET_ENV,
  resolveQueueSecret,
} from './queue-auth.js';

const SECRET = 'a'.repeat(64);

function delivery(headers: Record<string, string> = {}) {
  return new Request('http://localhost/.well-known/workflow/v1/flow', {
    method: 'POST',
    headers,
    body: '{"runId":"wrun_1"}',
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveQueueSecret', () => {
  it('prefers the configured secret, then the env var, and treats empty as unset', () => {
    vi.stubEnv(QUEUE_SECRET_ENV, 'from-env');
    expect(resolveQueueSecret('from-config')).toBe('from-config');
    expect(resolveQueueSecret()).toBe('from-env');
    vi.stubEnv(QUEUE_SECRET_ENV, '');
    expect(resolveQueueSecret()).toBeUndefined();
  });
});

describe('applyQueueAuthHeader', () => {
  it('replaces a caller-supplied credential with the configured one', () => {
    const headers = new Headers({ [QUEUE_AUTH_HEADER]: 'Bearer forged' });
    applyQueueAuthHeader(headers, SECRET);
    expect(headers.get(QUEUE_AUTH_HEADER)).toBe(`Bearer ${SECRET}`);
  });

  it('strips a caller-supplied credential when no secret is configured', () => {
    const headers = new Headers({ [QUEUE_AUTH_HEADER]: 'Bearer forged' });
    applyQueueAuthHeader(headers, undefined);
    expect(headers.has(QUEUE_AUTH_HEADER)).toBe(false);
  });
});

describe('authorizeQueueDelivery', () => {
  it('accepts the configured secret without reading the body', () => {
    const req = delivery({ [QUEUE_AUTH_HEADER]: `Bearer ${SECRET}` });
    expect(authorizeQueueDelivery(req, SECRET)).toBeUndefined();
    expect(req.bodyUsed).toBe(false);
  });

  it.each([
    ['missing', {}],
    ['wrong', { [QUEUE_AUTH_HEADER]: `Bearer ${'b'.repeat(64)}` }],
    ['no scheme', { [QUEUE_AUTH_HEADER]: SECRET }],
    ['wrong length', { [QUEUE_AUTH_HEADER]: `Bearer ${SECRET}x` }],
    ['in Authorization instead', { authorization: `Bearer ${SECRET}` }],
  ])('rejects a %s credential with 401 and never echoes it', async (_, headers) => {
    const req = delivery(headers);
    const res = authorizeQueueDelivery(req, SECRET);
    expect(res?.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(await res?.text()).not.toContain(SECRET);
  });

  it('enforces a configured secret even in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(authorizeQueueDelivery(delivery(), SECRET)?.status).toBe(401);
  });

  it.each([
    'development',
    'test',
  ])('accepts unauthenticated deliveries without a secret when NODE_ENV=%s', (env) => {
    vi.stubEnv('NODE_ENV', env);
    vi.stubEnv(QUEUE_SECRET_ENV, '');
    expect(authorizeQueueDelivery(delivery())).toBeUndefined();
  });

  it.each([
    'production',
    '',
  ])('fails closed with 503 without a secret when NODE_ENV=%j', async (env) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', env);
    vi.stubEnv(QUEUE_SECRET_ENV, '');
    const req = delivery({ [QUEUE_AUTH_HEADER]: `Bearer ${SECRET}` });
    const res = authorizeQueueDelivery(req);
    expect(res?.status).toBe(503);
    expect(req.bodyUsed).toBe(false);
    const body = (await res?.json()) as { detail: string };
    expect(body.detail).toContain(QUEUE_SECRET_ENV);
  });

  it('fails closed on a secret too short to be a random credential', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = delivery({ [QUEUE_AUTH_HEADER]: 'Bearer short' });
    expect(authorizeQueueDelivery(req, 'short')?.status).toBe(503);
  });
});
