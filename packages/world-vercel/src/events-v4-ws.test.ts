/**
 * `createWorkflowRunEventV4`'s WebSocket branch (`WORKFLOW_EVENTS_TRANSPORT=ws`).
 *
 * Kept out of `events-v4.test.ts` because the WS branch needs
 * `./ws-transport.js` mocked at the module level, and that file's HTTP
 * cases must keep exercising the real one. The transport's own socket
 * lifecycle is covered in `ws-transport.test.ts`; what matters here is the
 * adapter layer — how a reply frame becomes a `Response`-like result, and
 * what happens when it isn't one this client understands.
 */

import { EntityConflictError } from '@workflow/errors';
import { encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflowRunEventV4,
  isWsEventsTransportEnabled,
} from './events-v4.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';
import { type WsFrameReply, WsTransportError } from './ws-transport.js';

const requestMock = vi.fn<() => Promise<WsFrameReply>>();
const getWsEventsTransportMock = vi.fn(() => ({ request: requestMock }));

vi.mock('./ws-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ws-transport.js')>();
  return {
    ...actual,
    getWsEventsTransport: (...args: unknown[]) =>
      getWsEventsTransportMock(...(args as [])),
  };
});

const input = {
  runId: 'wrun_1',
  eventType: 'step_completed',
  specVersion: 2,
  correlationId: 'step_1',
};

/** A well-formed `event_ack` reply frame. */
const ack = (
  meta: Record<string, unknown> = {},
  body: Uint8Array = new Uint8Array(encode({ step: { stepId: 'step_1' } }))
): WsFrameReply => ({
  meta: {
    reqId: 1,
    type: 'event_ack',
    status: 201,
    eventId: 'evnt_1',
    runId: 'wrun_1',
    createdAt: '2026-06-10T00:00:00.000Z',
    ...meta,
  },
  body,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WORKFLOW_EVENTS_TRANSPORT = 'ws';
});

afterEach(() => {
  delete process.env.WORKFLOW_EVENTS_TRANSPORT;
});

/**
 * The gate is the whole safety story for this feature: everything else in
 * the PR is dead code for anyone who hasn't opted in. `events-v4.test.ts`
 * covers the HTTP path itself in depth, but nothing there pins the
 * *choice* of path — so a future edit that flipped the default (as an
 * earlier revision of this branch did deliberately, for benchmarking)
 * would sail through with every HTTP assertion still green, because the
 * two transports are built to be indistinguishable at the result layer.
 */
describe('transport gate', () => {
  it.each([
    ['ws', true],
    ['http', false],
    ['', false],
    ['WS', false],
  ])('%o resolves to ws=%o', (value, expected) => {
    process.env.WORKFLOW_EVENTS_TRANSPORT = value;
    expect(isWsEventsTransportEnabled()).toBe(expected);
  });

  it('defaults to HTTP when unset', () => {
    delete process.env.WORKFLOW_EVENTS_TRANSPORT;
    expect(isWsEventsTransportEnabled()).toBe(false);
  });

  it('goes over HTTP, never touching the WS transport, when the gate is off', async () => {
    delete process.env.WORKFLOW_EVENTS_TRANSPORT;
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/step_completed',
        method: 'POST',
      })
      .reply(200, encode({ step: { stepId: 'step_1' } }), {
        headers: {
          'x-wf-event-id': 'evnt_1',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': '2026-06-10T00:00:00.000Z',
        },
      });

    const result = await createWorkflowRunEventV4(input, {
      token: 'test-token',
      dispatcher: agent,
    });

    expect(result.eventId).toBe('evnt_1');
    expect(getWsEventsTransportMock).not.toHaveBeenCalled();
    agent.assertNoPendingInterceptors();
  });
});

describe('createWorkflowRunEventV4 over ws', () => {
  it('maps an event_ack reply onto the same result shape as HTTP', async () => {
    requestMock.mockResolvedValueOnce(ack());

    const result = await createWorkflowRunEventV4(input, {
      token: 'test-token',
    });

    expect(result.eventId).toBe('evnt_1');
    expect(result.runId).toBe('wrun_1');
    expect(result.createdAt).toBe('2026-06-10T00:00:00.000Z');
    expect(result.body.step).toMatchObject({ stepId: 'step_1' });
  });

  it('resolves the auth headers lazily, once per socket rather than per event', async () => {
    requestMock.mockResolvedValue(ack());

    await createWorkflowRunEventV4(input, { token: 'test-token' });

    // The transport is handed a thunk it calls at connect time — passing a
    // materialized header record here would mean minting a token on every
    // write and discarding all but the first.
    const [wsUrl, getHeaders] = getWsEventsTransportMock.mock.calls[0] as [
      string,
      unknown,
    ];
    expect(wsUrl).toContain('/websockets/v1/runs/wrun_1');
    expect(typeof getHeaders).toBe('function');
  });

  it('translates a non-2xx status into the same typed error HTTP raises', async () => {
    requestMock.mockResolvedValueOnce(
      ack(
        { status: 409, eventId: undefined },
        new TextEncoder().encode('{"message":"already applied"}')
      )
    );

    await expect(
      createWorkflowRunEventV4(input, { token: 'test-token' })
    ).rejects.toThrow(EntityConflictError);
  });

  it('fails closed when the reply carries no numeric status', async () => {
    // The protocol is designed to grow new response variants, so an older
    // client will meet a reply it doesn't understand. Defaulting that to
    // 200 would report a write as applied when nothing confirmed it.
    requestMock.mockResolvedValueOnce({
      meta: { reqId: 1, type: 'some_future_reply' },
      body: new Uint8Array(0),
    });

    await expect(
      createWorkflowRunEventV4(input, { token: 'test-token' })
    ).rejects.toThrow(/no numeric status/);
  });

  it('fails closed on an error frame rather than reading it as success', async () => {
    // 403 rather than 500: a 5xx is retryable (see the retry-parity suite
    // below), so it would be absorbed rather than surfaced. What this pins
    // is that an `error` frame is never mistaken for an ack.
    requestMock.mockResolvedValue({
      meta: { reqId: 1, type: 'error', status: 403 },
      body: new TextEncoder().encode('{"message":"boom"}'),
    });

    await expect(
      createWorkflowRunEventV4(input, { token: 'test-token' })
    ).rejects.toThrow();
  });
});

/**
 * The HTTP path gets transient-failure handling for free from undici's
 * `RetryAgent` (`RETRY_AGENT_OPTIONS`). The WS path never touches undici, so
 * the same policy is implemented in the adapter — and these tests exist
 * because the failure mode of losing it is invisible: writes still succeed,
 * they just cost a whole step retry instead of a 500ms backoff.
 */
describe('retry parity with the HTTP transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive a call to completion with the backoff timers auto-advanced. */
  const runWithTimers = async <T>(promise: Promise<T>): Promise<T> => {
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    if (!result.ok) throw result.error;
    return result.value;
  };

  it.each([
    500, 502, 503, 504,
  ])('retries a %i reply and succeeds, as the HTTP RetryAgent would', async (status) => {
    requestMock
      .mockResolvedValueOnce({
        meta: { reqId: 1, type: 'error', status },
        body: new TextEncoder().encode('{"message":"transient"}'),
      })
      .mockResolvedValueOnce(ack());

    const result = await runWithTimers(
      createWorkflowRunEventV4(input, { token: 'test-token' })
    );

    expect(result.eventId).toBe('evnt_1');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 429 — a firewall challenge must reach the queue', async () => {
    // Mirrors RETRY_AGENT_OPTIONS excluding 429 from `statusCodes`: this
    // client cannot solve a challenge, so retrying in-process only amplifies
    // load against an already-struggling firewall.
    requestMock.mockResolvedValue({
      meta: { reqId: 1, type: 'error', status: 429, retryAfter: '2' },
      body: new TextEncoder().encode('{"message":"slow down"}'),
    });

    await expect(
      runWithTimers(createWorkflowRunEventV4(input, { token: 'test-token' }))
    ).rejects.toThrow();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 4xx the server will reject identically', async () => {
    requestMock.mockResolvedValue({
      meta: { reqId: 1, type: 'error', status: 409 },
      body: new TextEncoder().encode('{"message":"already applied"}'),
    });

    await expect(
      runWithTimers(createWorkflowRunEventV4(input, { token: 'test-token' }))
    ).rejects.toThrow(EntityConflictError);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable transport failure, then surfaces it at the cap', async () => {
    requestMock.mockRejectedValue(
      new WsTransportError('connection closed (code 1006)', {
        retryable: true,
      })
    );

    await expect(
      runWithTimers(createWorkflowRunEventV4(input, { token: 'test-token' }))
    ).rejects.toThrow(/connection closed/);
    // 1 initial attempt + WS_MAX_RETRIES.
    expect(requestMock).toHaveBeenCalledTimes(6);
  });

  it('does not retry a transport failure marked non-retryable', async () => {
    // The stale-auth-token case: the bearer the server rejected is the only
    // one this invocation has, so re-sending is guaranteed to fail again.
    requestMock.mockRejectedValue(
      new WsTransportError('drained for auth expiry, same token', {
        retryable: false,
      })
    );

    await expect(
      runWithTimers(createWorkflowRunEventV4(input, { token: 'test-token' }))
    ).rejects.toThrow(/auth expiry/);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unrecognized reply variant', async () => {
    // A version mismatch, not a transient fault — re-sending can't fix it.
    requestMock.mockResolvedValue({
      meta: { reqId: 1, type: 'some_future_reply' },
      body: new Uint8Array(0),
    });

    await expect(
      runWithTimers(createWorkflowRunEventV4(input, { token: 'test-token' }))
    ).rejects.toThrow(/no numeric status/);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
