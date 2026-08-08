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
import type { WsFrameReply } from './ws-transport.js';

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
    requestMock.mockResolvedValueOnce({
      meta: { reqId: 1, type: 'error', status: 500 },
      body: new TextEncoder().encode('{"message":"boom"}'),
    });

    await expect(
      createWorkflowRunEventV4(input, { token: 'test-token' })
    ).rejects.toThrow();
  });
});
