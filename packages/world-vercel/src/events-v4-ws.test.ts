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

import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import { encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isRetryableEventPostError,
  MAX_EVENT_POST_RETRIES,
  withEventPostRetry,
} from './event-retry.js';
import {
  createWorkflowRunEventV4,
  isWsEventsTransportEnabled,
  warmWsEventsTransport,
} from './events-v4.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';
import { type WsFrameReply, WsTransportError } from './ws-transport.js';

const requestMock = vi.fn<() => Promise<WsFrameReply>>();
const warmMock = vi.fn<() => void>();
const getWsEventsTransportMock = vi.fn(() => ({
  request: requestMock,
  warm: warmMock,
}));

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

/**
 * The queue handler calls this on every message, for every World — including
 * the HTTP default and the proxy World that can't speak WS at all. So "does
 * nothing, quietly" is the contract being pinned here, as much as the warm
 * itself: a throw or an await here would land on the critical path of every
 * invocation, WS or not.
 */
describe('warmWsEventsTransport', () => {
  it('warms the run’s transport when the gate is on', () => {
    warmWsEventsTransport('wrun_1', { token: 'test-token' });

    expect(getWsEventsTransportMock).toHaveBeenCalledTimes(1);
    expect(warmMock).toHaveBeenCalledTimes(1);
  });

  it('does not even resolve a transport when the gate is off', () => {
    delete process.env.WORKFLOW_EVENTS_TRANSPORT;

    warmWsEventsTransport('wrun_1', { token: 'test-token' });

    expect(getWsEventsTransportMock).not.toHaveBeenCalled();
    expect(warmMock).not.toHaveBeenCalled();
  });

  it('does nothing for a World whose baseUrl is the api-workflow proxy', () => {
    // Same fallback `postEventFrameOverWs` takes: that gateway does not
    // forward a raw upgrade, so there is no socket worth warming.
    warmWsEventsTransport('wrun_1', {
      projectConfig: { projectId: 'prj_1', teamId: 'team_1' },
    });

    expect(getWsEventsTransportMock).not.toHaveBeenCalled();
    expect(warmMock).not.toHaveBeenCalled();
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
 * Retry is owned by `withEventPostRetry` (`event-retry.ts`) for both transports
 * — it is the only layer that knows which event types are idempotent-on-retry,
 * and an earlier revision of this branch had a *second* loop inside the WS
 * adapter that sat underneath it and therefore defeated that gate entirely
 * (`step_started` got retried 6 times, double-incrementing the attempt counter,
 * while an eligible type got 3 × 6 attempts with the inner backoff reaching 30s
 * against an outer base deliberately set to 100ms).
 *
 * What keeps the shared loop working for WS without a WS-specific branch is the
 * error *shape*: every transport failure leaves this adapter as a
 * `WorkflowWorldError` with `code: 'TRANSPORT'`, the same thing `utils.ts`
 * produces for a failed `fetch`. These tests pin both halves — that the adapter
 * itself attempts exactly once, and that what it throws is classified the way
 * the shared policy needs.
 */
describe('retry is owned by the shared policy, not the adapter', () => {
  it.each([
    500, 502, 503, 504,
  ])('attempts a %i reply exactly once — the retry lives one layer up', async (status) => {
    requestMock.mockResolvedValue({
      meta: { reqId: 1, type: 'error', status },
      body: new TextEncoder().encode('{"message":"transient"}'),
    });

    await expect(
      createWorkflowRunEventV4(input, { token: 'test-token' })
    ).rejects.toThrow();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 4xx the server will reject identically', async () => {
    requestMock.mockResolvedValue({
      meta: { reqId: 1, type: 'error', status: 409 },
      body: new TextEncoder().encode('{"message":"already applied"}'),
    });

    await expect(
      createWorkflowRunEventV4(input, { token: 'test-token' })
    ).rejects.toThrow(EntityConflictError);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('wraps a transport failure as a TRANSPORT WorkflowWorldError', async () => {
    // A bare `WsTransportError` fails `WorkflowWorldError.is()` (the `@workflow/errors`
    // checks are name-based), which would let it escape both the in-process
    // retry and the queue's redelivery classification and surface as a
    // USER_ERROR — blaming the workflow's own code for a dead socket.
    const cause = new WsTransportError('connection closed (code 1006)');
    requestMock.mockRejectedValue(cause);

    const err = await createWorkflowRunEventV4(input, {
      token: 'test-token',
    }).catch((e: unknown) => e);

    expect(WorkflowWorldError.is(err)).toBe(true);
    expect((err as WorkflowWorldError).code).toBe('TRANSPORT');
    expect((err as WorkflowWorldError).cause).toBe(cause);
    expect((err as Error).message).toMatch(/connection closed \(code 1006\)/);
    // And the shared policy recognizes it, which is the whole point of the shape.
    expect(isRetryableEventPostError(err)).toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('raises an unrecognized reply variant as a PARSE_ERROR', async () => {
    // A version skew, not a transient fault — but the write may or may not have
    // landed, so it is retryable for the types that can absorb a replay (a
    // landed original comes back as a 409 the SDK already handles).
    requestMock.mockResolvedValue({
      meta: { reqId: 1, type: 'some_future_reply' },
      body: new Uint8Array(0),
    });

    const err = await createWorkflowRunEventV4(input, {
      token: 'test-token',
    }).catch((e: unknown) => e);

    expect((err as WorkflowWorldError).code).toBe('PARSE_ERROR');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a 429 to the runtime rather than absorbing it in-process', async () => {
    requestMock.mockResolvedValue({
      meta: { reqId: 1, type: 'error', status: 429, retryAfter: '2' },
      body: new TextEncoder().encode('{"message":"slow down"}'),
    });

    const err = await createWorkflowRunEventV4(input, {
      token: 'test-token',
    }).catch((e: unknown) => e);

    expect(isRetryableEventPostError(err)).toBe(false);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The composition, end to end: the same loop the HTTP path already runs under,
 * driving WS writes. These would have passed before too — but only because the
 * adapter's own loop was doing the work; they pin that the *outer* loop is what
 * retries now, and in particular that its per-event-type gate is back in force.
 */
describe('withEventPostRetry over ws', () => {
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

  it('retries a dead socket for an idempotent-on-retry event type', async () => {
    requestMock
      .mockRejectedValueOnce(new WsTransportError('connection closed (1006)'))
      .mockResolvedValueOnce(ack());

    const result = await runWithTimers(
      withEventPostRetry(
        () => createWorkflowRunEventV4(input, { token: 'test-token' }),
        'step_completed'
      )
    );

    expect(result.eventId).toBe('evnt_1');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces it for queue redelivery once the shared cap is reached', async () => {
    requestMock.mockRejectedValue(new WsTransportError('connection closed'));

    await expect(
      runWithTimers(
        withEventPostRetry(
          () => createWorkflowRunEventV4(input, { token: 'test-token' }),
          'step_completed'
        )
      )
    ).rejects.toThrow(/connection closed/);
    // MAX_EVENT_POST_RETRIES + the initial attempt — not the 6 the removed
    // adapter-level loop produced, and not 3 × 6 in composition with it.
    expect(requestMock).toHaveBeenCalledTimes(MAX_EVENT_POST_RETRIES + 1);
  });

  it('does NOT retry step_started, whose handler double-counts attempts', async () => {
    // This is the case the adapter-level loop silently defeated: the gate lives
    // in EVENT_RETRY_ELIGIBILITY, one layer above where that loop sat.
    requestMock.mockRejectedValue(new WsTransportError('connection closed'));

    await expect(
      runWithTimers(
        withEventPostRetry(
          () =>
            createWorkflowRunEventV4(
              { ...input, eventType: 'step_started' },
              { token: 'test-token' }
            ),
          'step_started'
        )
      )
    ).rejects.toThrow(/connection closed/);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a definitive 4xx reply', async () => {
    requestMock.mockResolvedValue({
      meta: { reqId: 1, type: 'error', status: 409 },
      body: new TextEncoder().encode('{"message":"already applied"}'),
    });

    await expect(
      runWithTimers(
        withEventPostRetry(
          () => createWorkflowRunEventV4(input, { token: 'test-token' }),
          'step_completed'
        )
      )
    ).rejects.toThrow(EntityConflictError);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
