import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import { encode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  FIREWALL_DENY_RETRY_DELAY_MS,
  fetchResponse,
  isFirewallDeny,
  withFirewallDenyRetry,
} from './firewall-deny-retry.js';
import { instrumentedFetch } from './http-core.js';
import { makeRequest } from './utils.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

/** What the Vercel edge answers when the Firewall denies a request. */
const firewallDeny = () =>
  new Response('Forbidden', {
    status: 403,
    headers: { 'x-vercel-mitigated': 'deny' },
  });

/** A 403 the service behind the edge decided. */
const serviceForbidden = () =>
  Response.json({ error: 'Forbidden' }, { status: 403 });

const ok = () =>
  new Response(encode({ value: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/cbor' },
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Settles `promise` while running the timers it waits on. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let result: { value: T } | { error: unknown } | undefined;
  promise.then(
    (value) => {
      result = { value };
    },
    (error: unknown) => {
      result = { error };
    }
  );
  // The request may start only after real I/O (credentials, headers), so
  // its wait starts late too: let real time pass between fake-clock steps.
  for (let i = 0; i < 200 && !result; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(500);
  }
  if (!result) throw new Error('did not settle within 100 fake seconds');
  if ('error' in result) throw result.error;
  return result.value;
}

describe('isFirewallDeny', () => {
  it('is a 403 with x-vercel-mitigated: deny, and nothing else', () => {
    expect(isFirewallDeny(403, 'deny')).toBe(true);
    expect(isFirewallDeny(403, null)).toBe(false);
    expect(isFirewallDeny(403, undefined)).toBe(false);
    expect(isFirewallDeny(403, 'challenge')).toBe(false);
    expect(isFirewallDeny(429, 'challenge')).toBe(false);
    expect(isFirewallDeny(429, 'deny')).toBe(false);
    expect(isFirewallDeny(200, 'deny')).toBe(false);
  });
});

describe('withFirewallDenyRetry', () => {
  const options = { ...fetchResponse, label: 'GET /test' };

  it('re-sends a request the Firewall denied, once, after 10 seconds', async () => {
    const send = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(firewallDeny())
      .mockResolvedValueOnce(new Response('ok'));

    const pending = withFirewallDenyRetry(send, options);
    await vi.advanceTimersByTimeAsync(FIREWALL_DENY_RETRY_DELAY_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;

    expect(FIREWALL_DENY_RETRY_DELAY_MS).toBe(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('The Vercel Firewall denied GET /test')
    );
  });

  it('returns the second deny instead of retrying again', async () => {
    const send = vi.fn(async () => firewallDeny());

    const response = await settle(withFirewallDenyRetry(send, options));
    await vi.advanceTimersByTimeAsync(FIREWALL_DENY_RETRY_DELAY_MS * 3);

    expect(send).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(403);
  });

  it.each([
    ['a 403 the service sent', serviceForbidden],
    [
      'a 403 with another mitigation',
      () =>
        new Response('', {
          status: 403,
          headers: { 'x-vercel-mitigated': 'challenge' },
        }),
    ],
    [
      'a Firewall challenge (429)',
      () =>
        new Response('', {
          status: 429,
          headers: { 'x-vercel-mitigated': 'challenge' },
        }),
    ],
    ['a 500', () => new Response('', { status: 500 })],
  ])('does not retry %s', async (_name, respond) => {
    const send = vi.fn(async () => respond());

    const response = await settle(withFirewallDenyRetry(send, options));

    expect(send).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(respond().status);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('stops waiting when the signal aborts, with its reason', async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => firewallDeny());

    const pending = withFirewallDenyRetry(send, {
      ...options,
      signal: controller.signal,
    });
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const reason = new Error('deadline');
    controller.abort(reason);

    expect(await outcome).toBe(reason);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('makeRequest: a request the Vercel Firewall denied', () => {
  const schema = z.object({ value: z.string() });

  beforeEach(() => {
    // Driven from a stubbed `fetch`, which the node:http client never calls.
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
  });

  it('re-sends the request, body included, after 10 seconds', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (request: Request) => {
      bodies.push(Buffer.from(await request.arrayBuffer()).toString('hex'));
      return fetchMock.mock.calls.length === 1 ? firewallDeny() : ok();
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await settle(
      makeRequest({
        endpoint: '/v2/runs/wrun_test/events',
        options: { method: 'POST' },
        data: { eventType: 'step_started' },
        schema,
      })
    );

    expect(result).toEqual({ value: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toBe(
      Buffer.from(encode({ eventType: 'step_started' })).toString('hex')
    );
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('does not re-send a 403 world-vercel itself sent', async () => {
    const fetchMock = vi.fn(async () => serviceForbidden());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      settle(
        makeRequest({
          endpoint: '/v2/runs/wrun_test',
          options: { method: 'GET' },
          schema,
        })
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('instrumentedFetch: a request the Vercel Firewall denied', () => {
  beforeEach(() => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
  });

  it('re-sends the request after 10 seconds and reports one dispatch', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return fetchMock.mock.calls.length === 1
        ? firewallDeny()
        : new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onRequestDispatched = vi.fn();

    const response = await settle(
      instrumentedFetch({
        method: 'POST',
        url: 'https://world.example.com/v4/runs/wrun_test/events',
        headers: new Headers(),
        body: 'payload',
        peerService: 'world-vercel',
        onRequestDispatched,
      })
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies).toEqual(['payload', 'payload']);
    expect(onRequestDispatched).toHaveBeenCalledTimes(1);
  });

  it('does not re-send a 403 without the Firewall header', async () => {
    const fetchMock = vi.fn(async () => serviceForbidden());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      settle(
        instrumentedFetch({
          method: 'GET',
          url: 'https://world.example.com/v4/runs/wrun_test',
          headers: new Headers(),
          peerService: 'world-vercel',
        })
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
