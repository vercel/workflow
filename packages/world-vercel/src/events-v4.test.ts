import {
  EntityConflictError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import { encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflowRunEventV4,
  getEventV4,
  getWorkflowRunEventsV4,
  throwForErrorResponse,
} from './events-v4.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';

/**
 * The v4 client must preserve the typed-error contract of the v3
 * `makeRequest` path — the workflow runtime branches on these types
 * (`RunExpiredError.is`, `TooEarlyError.is`, the 404 → HookNotFoundError
 * translation in events.ts) for core retry/terminal-state control flow.
 */
describe('throwForErrorResponse', () => {
  const call = (
    status: number,
    body = '{"message":"boom"}',
    headers: Record<string, string> = {}
  ) => throwForErrorResponse(status, headers, body, 'createEvent', 'http://x');

  it('maps 409 to EntityConflictError', () => {
    expect(() => call(409)).toThrowError(EntityConflictError);
  });

  it('maps 410 to RunExpiredError (terminal run — runtime must not retry)', () => {
    expect(() => call(410)).toThrowError(RunExpiredError);
  });

  it('maps 425 to TooEarlyError with retryAfter from the header', () => {
    try {
      call(425, '{"message":"too early"}', { 'retry-after': '7' });
      expect.unreachable();
    } catch (err) {
      expect(TooEarlyError.is(err)).toBe(true);
      expect((err as TooEarlyError).retryAfter).toBe(7);
    }
  });

  it('maps 429 to ThrottleError with retryAfter from the header', () => {
    try {
      call(429, '{"message":"slow down"}', { 'retry-after': '30' });
      expect.unreachable();
    } catch (err) {
      expect(ThrottleError.is(err)).toBe(true);
      expect((err as ThrottleError).retryAfter).toBe(30);
    }
  });

  it('maps 404 to WorkflowWorldError with status (hook → HookNotFoundError translation keys off this)', () => {
    try {
      call(404, '{"message":"hook not found","code":"not_found"}');
      expect.unreachable();
    } catch (err) {
      expect(WorkflowWorldError.is(err)).toBe(true);
      expect((err as WorkflowWorldError).status).toBe(404);
      expect((err as WorkflowWorldError).code).toBe('not_found');
      expect((err as WorkflowWorldError).message).toBe('hook not found');
    }
  });

  it('maps 5xx to WorkflowWorldError with status (runtime treats as retryable)', () => {
    try {
      call(503);
      expect.unreachable();
    } catch (err) {
      expect(WorkflowWorldError.is(err)).toBe(true);
      expect((err as WorkflowWorldError).status).toBe(503);
    }
  });

  it('keeps a useful message when the body is not JSON', () => {
    expect(() => call(500, 'plain text oops')).toThrowError(
      /createEvent failed: HTTP 500 plain text oops/
    );
  });
});

/**
 * Full HTTP round-trip through getWorkflowRunEventsV4 — exercises the
 * undici response-body → decodeFrames path that previously crashed in
 * Next.js webpack bundles (node:stream Readable.toWeb), and verifies
 * `config.dispatcher` is honored (it was silently ignored before).
 */
describe('getWorkflowRunEventsV4 over HTTP', () => {
  it('parses a frame stream fetched via a custom dispatcher', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    const body = new TextEncoder().encode('payload-bytes');
    const frames = Buffer.concat([
      encodeFrame(
        {
          eventId: 'evnt_1',
          runId: 'wrun_1',
          eventType: 'run_created',
          createdAt: '2026-06-10T00:00:00.000Z',
          eventData: {},
        },
        body
      ),
      encodeFrame({ _end: 1, next: 'cursor-2' }, new Uint8Array(0)),
    ]);

    agent
      .get(origin)
      .intercept({ path: '/api/v4/runs/wrun_1/events', method: 'GET' })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getWorkflowRunEventsV4(
      'wrun_1',
      {},
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0].event.eventId).toBe('evnt_1');
    expect(new Uint8Array(result.events[0].body)).toEqual(body);
    expect(result.next).toBe('cursor-2');
    agent.assertNoPendingInterceptors();
  });

  it('captures an explicit hasMore from the sentinel, independent of next', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    // The regression shape: a final page still carries a trailing `next`
    // cursor (incremental-load resume point) but hasMore is false.
    const frames = Buffer.concat([
      encodeFrame(
        {
          eventId: 'evnt_1',
          runId: 'wrun_1',
          eventType: 'run_created',
          createdAt: '2026-06-10T00:00:00.000Z',
          eventData: {},
        },
        new Uint8Array(0)
      ),
      encodeFrame(
        { _end: 1, next: 'eid:last', hasMore: false },
        new Uint8Array(0)
      ),
    ]);

    agent
      .get(origin)
      .intercept({ path: '/api/v4/runs/wrun_1/events', method: 'GET' })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getWorkflowRunEventsV4(
      'wrun_1',
      {},
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.next).toBe('eid:last');
    expect(result.hasMore).toBe(false);
  });

  it('leaves hasMore undefined for a legacy sentinel without the flag', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    const frames = encodeFrame(
      { _end: 1, next: 'cursor-2' },
      new Uint8Array(0)
    );

    agent
      .get(origin)
      .intercept({ path: '/api/v4/runs/wrun_1/events', method: 'GET' })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getWorkflowRunEventsV4(
      'wrun_1',
      {},
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.next).toBe('cursor-2');
    expect(result.hasMore).toBeUndefined();
  });

  it('throws when the stream ends without the end sentinel (truncated response)', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    // A complete event frame but NO `{_end: 1}` sentinel — what a response
    // truncated on a frame boundary looks like. Returning this as a
    // successful page would silently drop events with hasMore=false.
    const frames = encodeFrame(
      {
        eventId: 'evnt_1',
        runId: 'wrun_1',
        eventType: 'run_created',
        createdAt: '2026-06-10T00:00:00.000Z',
        eventData: {},
      },
      new Uint8Array(0)
    );

    agent
      .get(origin)
      .intercept({ path: '/api/v4/runs/wrun_1/events', method: 'GET' })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    await expect(
      getWorkflowRunEventsV4(
        'wrun_1',
        {},
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow(/end-of-stream sentinel/);
  });
});

/**
 * getEventV4 returns after the first frame. The early return must cancel the
 * response body (releasing its undici socket) without corrupting the returned
 * value or hanging — the trailing frame below is never read.
 */
describe('getEventV4 over HTTP', () => {
  it('returns the first frame and stops reading the rest', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    const body = new TextEncoder().encode('event-payload');
    const frames = Buffer.concat([
      encodeFrame(
        {
          eventId: 'evnt_1',
          runId: 'wrun_1',
          eventType: 'run_created',
          createdAt: '2026-06-10T00:00:00.000Z',
          eventData: {},
        },
        body
      ),
      // Trailing bytes the reader must never need.
      encodeFrame({ eventId: 'evnt_unused' }, new Uint8Array(8)),
    ]);

    agent
      .get(origin)
      .intercept({ path: '/api/v4/runs/wrun_1/events/evnt_1', method: 'GET' })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const { event, body: returnedBody } = await getEventV4('wrun_1', 'evnt_1', {
      token: 'test-token',
      dispatcher: agent,
    });

    expect(event.eventId).toBe('evnt_1');
    expect(event.eventType).toBe('run_created');
    expect(new Uint8Array(returnedBody)).toEqual(body);
    agent.assertNoPendingInterceptors();
  });
});

/**
 * Regression: v4 requests must go through the global `fetch`, not undici's
 * `request()`. Vercel's observability log viewer instruments the global
 * `fetch`; calling `undici.request()` directly bypassed it, so outgoing v4
 * event traffic stopped appearing in the log viewer (queue traffic, on
 * `fetch`, kept showing). See the beta.16 regression. This test fails if the
 * transport ever reverts to `undici.request()`.
 */
describe('v4 transport uses global fetch (observability)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes a v4 LIST through globalThis.fetch', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(origin)
      .intercept({ path: '/api/v4/runs/wrun_1/events', method: 'GET' })
      .reply(200, encodeFrame({ _end: 1 }, new Uint8Array(0)), {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    // Spy passes through to the real fetch (which MockAgent intercepts at
    // the dispatcher layer) so we only assert the entry point was used.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await getWorkflowRunEventsV4(
      'wrun_1',
      {},
      { token: 'test-token', dispatcher: agent }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toContain('/api/v4/runs/wrun_1/events');
    agent.assertNoPendingInterceptors();

    // Cache-busting header must be set so Next.js fetch memoization / Data
    // Cache can't serve a stale/truncated event page (replay correctness).
    // See https://github.com/vercel/workflow/issues/618.
    const sentHeaders = new Headers(calledInit?.headers as HeadersInit);
    expect(sentHeaders.get('x-request-time')).toBeTruthy();
  });
});

describe('createWorkflowRunEventV4 over HTTP', () => {
  it('POSTs to the /events/:eventType alias and decodes the response', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(origin)
      .intercept({
        // The event type rides in the URL purely as an observability hint
        // (access logs / traces); the frame meta stays authoritative.
        path: '/api/v4/runs/wrun_1/events/step_completed',
        method: 'POST',
      })
      .reply(200, encode({ step: { stepId: 'step_1', status: 'completed' } }), {
        headers: {
          'x-wf-event-id': 'evnt_1',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': '2026-06-10T00:00:00.000Z',
        },
      });

    const result = await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: 'step_completed',
        specVersion: 2,
        correlationId: 'step_1',
        payload: new TextEncoder().encode('"result"'),
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.eventId).toBe('evnt_1');
    expect(result.runId).toBe('wrun_1');
    expect(result.createdAt).toBe('2026-06-10T00:00:00.000Z');
    expect(result.body.step).toMatchObject({ stepId: 'step_1' });
    agent.assertNoPendingInterceptors();
  });
});
