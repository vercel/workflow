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

import * as otel from '@opentelemetry/api';
import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isRetryableEventPostError,
  MAX_EVENT_POST_RETRIES,
  withEventPostRetry,
} from './event-retry.js';
import { createWorkflowRunEventV4 } from './events-v4.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';
import { type WsFrameReply, WsTransportError } from './ws-transport.js';

const WS_URL = 'wss://vercel-workflow.com/api/websockets/v1/runs/wrun_1';

const requestMock = vi.fn<() => Promise<WsFrameReply>>();
/**
 * `resolveWsTransport` is the seam to mock, not `getWsEventsTransport`: URL
 * resolution, proxy fallback and the header thunk all call each other *inside*
 * `ws-transport.js`, and an ESM mock replaces a module's exports, not its own
 * call sites. Those selection cases live in `ws-transport.test.ts`.
 */
const resolveWsTransportMock = vi.fn(() => ({
  transport: { request: requestMock },
  wsUrl: WS_URL,
}));

vi.mock('./ws-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ws-transport.js')>();
  return {
    ...actual,
    resolveWsTransport: (...args: unknown[]) =>
      resolveWsTransportMock(...(args as [])),
  };
});

const CREATED_AT = '2026-06-10T00:00:00.000Z';

const input = {
  runId: 'wrun_1',
  eventType: 'step_completed',
  specVersion: 2,
  correlationId: 'step_1',
} as const;

/**
 * The materialized CBOR body a `step_completed` write answers with. Shared by
 * the WS reply frames and the HTTP interceptors below so the two transports are
 * asserted against one shape — the point of the adapter is that the caller
 * cannot tell them apart.
 */
const materializedBody = () =>
  new Uint8Array(
    encode({
      event: {
        eventId: 'evnt_1',
        runId: 'wrun_1',
        createdAt: CREATED_AT,
        eventType: 'step_completed',
        specVersion: 2,
        correlationId: 'step_1',
        eventData: { result: new Uint8Array() },
      },
      step: {
        runId: 'wrun_1',
        stepId: 'step_1',
        stepName: 'step',
        status: 'completed',
        attempt: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    })
  );

/** A well-formed `event_ack` reply frame. */
const ack = (
  meta: Record<string, unknown> = {},
  body: Uint8Array = materializedBody()
): WsFrameReply => ({
  meta: {
    reqId: 1,
    type: 'event_ack',
    status: 201,
    eventId: 'evnt_1',
    runId: 'wrun_1',
    createdAt: CREATED_AT,
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
  delete process.env.WORKFLOW_INTERNAL_EVENTS_TRANSPORT_STRICT;
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
/**
 * Strict mode exists because an event written over HTTP and one written over
 * the socket produce the same run outcome, so the WS e2e lane passes either
 * way. These pin the two halves that make it usable: it fires on the one event
 * type that should never fall back, and it stays out of the way of the several
 * that legitimately do.
 */
describe('strict fallback (WORKFLOW_INTERNAL_EVENTS_TRANSPORT_STRICT)', () => {
  const httpReply = (path: string) => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(origin)
      .intercept({ path, method: 'POST' })
      .reply(200, materializedBody(), {
        headers: {
          'x-wf-event-id': 'evnt_1',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': CREATED_AT,
        },
      });
    return agent;
  };

  it('fails a step_completed that falls back while the gate is on', async () => {
    process.env.WORKFLOW_INTERNAL_EVENTS_TRANSPORT_STRICT = '1';
    // No channel for this run: exactly the state that used to demote the write
    // to HTTP without a trace.
    // `Once`, matching the rest of this file: a permanent override
    // leaks into every later test, since clearAllMocks resets calls, not
    // implementations.
    resolveWsTransportMock.mockReturnValueOnce(null);

    await expect(
      createWorkflowRunEventV4(input, { token: 'test-token' })
    ).rejects.toThrow(/fell back to the HTTP events transport/);
  });

  it('leaves step_started alone, which falls back legitimately', async () => {
    process.env.WORKFLOW_INTERNAL_EVENTS_TRANSPORT_STRICT = '1';
    // `Once`, matching the rest of this file: a permanent override
    // leaks into every later test, since clearAllMocks resets calls, not
    // implementations.
    resolveWsTransportMock.mockReturnValueOnce(null);
    // Not in the strict set on purpose: after vercel/workflow#3732 a write
    // issued before the socket finishes connecting takes HTTP by design, and
    // on a cold instance that can be the first step_started of a run.
    const agent = httpReply('/api/v4/runs/wrun_1/events/step_started');

    // The claim is only that strict mode did not block the fallback, so this
    // asserts on that and on the request having been made. Decoding the reply
    // is not the point and `materializedBody` is shaped for step_completed —
    // building a second fixture here would test the fixture, not the gate.
    const error = await createWorkflowRunEventV4(
      { ...input, eventType: 'step_started' },
      { token: 'test-token', dispatcher: agent }
    ).catch((err: unknown) => err);

    expect(String(error)).not.toMatch(/fell back to the HTTP events transport/);
    agent.assertNoPendingInterceptors();
  });

  it('is off unless the value is exactly 1 or true', async () => {
    // The opposite asymmetry from the transport gate, on purpose: strict mode
    // fails runs, so it must not be acquired by a typo.
    process.env.WORKFLOW_INTERNAL_EVENTS_TRANSPORT_STRICT = 'yes';
    // `Once`, matching the rest of this file: a permanent override
    // leaks into every later test, since clearAllMocks resets calls, not
    // implementations.
    resolveWsTransportMock.mockReturnValueOnce(null);
    const agent = httpReply('/api/v4/runs/wrun_1/events/step_completed');

    const result = await createWorkflowRunEventV4(input, {
      token: 'test-token',
      dispatcher: agent,
    });

    expect(result.event.eventId).toBe('evnt_1');
    agent.assertNoPendingInterceptors();
  });
});

describe('transport gate', () => {
  it('goes over HTTP, never touching the WS transport, when the gate is off', async () => {
    // "Off" is now an explicit opt-out rather than an absent variable, since
    // the default flipped. Deleting it here would assert the opposite of what
    // this test is named for.
    process.env.WORKFLOW_EVENTS_TRANSPORT = 'http';
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
      .reply(200, materializedBody(), {
        headers: {
          'x-wf-event-id': 'evnt_1',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': CREATED_AT,
        },
      });

    const result = await createWorkflowRunEventV4(input, {
      token: 'test-token',
      dispatcher: agent,
    });

    expect(result.event.eventId).toBe('evnt_1');
    expect(resolveWsTransportMock).not.toHaveBeenCalled();
    agent.assertNoPendingInterceptors();
  });
});

describe('createWorkflowRunEventV4 over ws', () => {
  it('maps an event_ack reply onto the same result shape as HTTP', async () => {
    requestMock.mockResolvedValueOnce(ack());

    const result = await createWorkflowRunEventV4(input, {
      token: 'test-token',
    });

    expect(result.event.eventId).toBe('evnt_1');
    expect(result.event.runId).toBe('wrun_1');
    expect(result.event.eventType).toBe('step_completed');
    expect(result.step).toMatchObject({ stepId: 'step_1' });
  });

  it('falls back to HTTP when this World has no usable WS transport', async () => {
    // `resolveWsTransport` returns null for the api-workflow proxy World (see
    // `ws-transport.test.ts`). The gate is still on here, so the write has to
    // complete over HTTP rather than fail — that fallback is the reason the
    // resolve step returns null instead of throwing.
    resolveWsTransportMock.mockReturnValueOnce(
      null as unknown as {
        transport: { request: typeof requestMock };
        wsUrl: string;
      }
    );
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
      .reply(200, materializedBody(), {
        headers: {
          'x-wf-event-id': 'evnt_1',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': CREATED_AT,
        },
      });

    const result = await createWorkflowRunEventV4(input, {
      token: 'test-token',
      dispatcher: agent,
    });

    expect(result.event.eventId).toBe('evnt_1');
    expect(requestMock).not.toHaveBeenCalled();
    agent.assertNoPendingInterceptors();
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

    expect(result.event.eventId).toBe('evnt_1');
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

// The write's traceparent/tracestate ride the frame envelope (not `event`,
// which is the HTTP wire format) so server spans parent to the write rather
// than to the connection's upgrade.
describe('per-frame trace context', () => {
  afterEach(() => {
    otel.propagation.disable();
  });

  /** Decode the CBOR meta block of a single encoded frame. */
  const frameMeta = (frame: Uint8Array): Record<string, unknown> => {
    const metaLen = new DataView(frame.buffer, frame.byteOffset).getUint32(
      0,
      false
    );
    return decode(frame.subarray(4, 4 + metaLen));
  };

  const captureFrame = () => {
    let frame: Uint8Array | undefined;
    requestMock.mockImplementation(
      async (...args: unknown[]): Promise<WsFrameReply> => {
        const build = args[0] as (reqId: number) => Uint8Array;
        frame = build(1);
        return ack();
      }
    );
    return () => {
      if (!frame) throw new Error('transport.request never built a frame');
      return frameMeta(frame);
    };
  };

  it('stamps traceparent and tracestate onto the frame envelope', async () => {
    otel.propagation.setGlobalPropagator({
      inject: (_context, carrier, setter) => {
        setter.set(
          carrier,
          'traceparent',
          '00-11111111111111111111111111111111-2222222222222222-01'
        );
        setter.set(carrier, 'tracestate', 'vendor=1');
      },
      extract: (context) => context,
      fields: () => ['traceparent', 'tracestate'],
    });
    const meta = captureFrame();

    await createWorkflowRunEventV4(input, { token: 'test-token' });

    expect(meta()).toMatchObject({
      reqId: 1,
      type: 'event',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      tracestate: 'vendor=1',
    });
    // The event meta itself is the HTTP wire format and must stay free of
    // WS-only fields.
    expect(
      (meta().event as Record<string, unknown>).traceparent
    ).toBeUndefined();
  });

  it('omits the fields entirely when no propagator injects anything', async () => {
    const meta = captureFrame();

    await createWorkflowRunEventV4(input, { token: 'test-token' });

    expect(meta()).not.toHaveProperty('traceparent');
    expect(meta()).not.toHaveProperty('tracestate');
  });
});
