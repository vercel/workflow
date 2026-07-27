import {
  EntityConflictError,
  PreconditionFailedError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitEventDataForV4 } from './events.js';
import {
  createWorkflowRunEventV4,
  getEventV4,
  getWorkflowRunEventsV4,
  throwForErrorResponse,
} from './events-v4.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

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

  it('maps a firewall challenge (429 + x-vercel-mitigated: challenge) to a retryable TRANSPORT WorkflowWorldError, not ThrottleError', () => {
    // The hot event-write path (step_started included) must route a challenge
    // to the TRANSPORT path so the runtime rethrows it to the queue (backoff +
    // cap) rather than deferring it into an uncapped flat re-enqueue loop.
    try {
      call(429, '{"message":"rate limited"}', {
        'x-vercel-mitigated': 'challenge',
        'retry-after': '5',
      });
      expect.unreachable();
    } catch (err) {
      expect(ThrottleError.is(err)).toBe(false);
      expect(WorkflowWorldError.is(err)).toBe(true);
      expect((err as WorkflowWorldError).code).toBe('TRANSPORT');
      expect((err as WorkflowWorldError).status).toBe(429);
      expect((err as WorkflowWorldError).message).toContain(
        'x-vercel-mitigated=challenge'
      );
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
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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

  it('forwards skipPreload in the run_started frame meta (turbo preload opt-out)', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    // Decode the posted frame's CBOR meta block:
    //   u32_be(meta_len) || cbor_meta || u32_be(body_len) || body
    let capturedMeta: Record<string, unknown> | undefined;
    const captureMeta = (rawBody: unknown) => {
      const bytes =
        typeof rawBody === 'string'
          ? new TextEncoder().encode(rawBody)
          : new Uint8Array(rawBody as ArrayBufferLike);
      const metaLen = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      ).getUint32(0, false);
      capturedMeta = decode(bytes.subarray(4, 4 + metaLen)) as Record<
        string,
        unknown
      >;
    };

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          captureMeta(opts.body);
          return encode({ run: { runId: 'wrun_1', status: 'running' } });
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: 'run_started',
        specVersion: 5,
        skipPreload: true,
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.eventType).toBe('run_started');
    expect(capturedMeta?.skipPreload).toBe(true);
    agent.assertNoPendingInterceptors();
  });

  it('omits skipPreload from the frame meta when not set (default / old SDK parity)', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedMeta: Record<string, unknown> | undefined;
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          const bytes = new Uint8Array(opts.body as ArrayBufferLike);
          const metaLen = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
          ).getUint32(0, false);
          capturedMeta = decode(bytes.subarray(4, 4 + metaLen)) as Record<
            string,
            unknown
          >;
          return encode({ run: { runId: 'wrun_1', status: 'running' } });
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    await createWorkflowRunEventV4(
      { runId: 'wrun_1', eventType: 'run_started', specVersion: 5 },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.eventType).toBe('run_started');
    expect('skipPreload' in (capturedMeta ?? {})).toBe(false);
    agent.assertNoPendingInterceptors();
  });

  it('surfaces the events a 412 carries as decoded PreconditionFailedError details', async () => {
    // A rejecting backend MAY return the events the client was missing, so the
    // replay restart needs no events.list round trip. They arrive as JSON, so
    // nested dates must come back as Date instances or the runtime crashes on
    // .getTime() deep in the replay.
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/wait_created',
        method: 'POST',
      })
      .reply(
        412,
        JSON.stringify({
          success: false,
          error: 'precondition-failed',
          code: 'precondition-failed',
          message: 'Run state is stale',
          cursor: 'eid:evnt_missing',
          events: [
            {
              eventId: 'evnt_missing',
              runId: 'wrun_1',
              eventType: 'wait_created',
              correlationId: 'wait_0',
              specVersion: 5,
              createdAt: '2026-06-10T00:00:00.000Z',
              eventData: { resumeAt: '2026-06-10T00:00:05.000Z' },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } }
      );

    const error = await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: 'wait_created',
        specVersion: 5,
        correlationId: 'wait_1',
        stateUpdatedAt: 1747742400000,
        stateEventCount: 3,
        stateCursor: 'eid:evnt_3',
      },
      { token: 'test-token', dispatcher: agent }
    ).catch((err: unknown) => err);

    expect(PreconditionFailedError.is(error)).toBe(true);
    const details = (error as PreconditionFailedError).details as {
      events: Array<{
        eventId: string;
        eventData: { resumeAt: unknown };
      }>;
      cursor?: string;
    };
    expect(details.cursor).toBe('eid:evnt_missing');
    expect(details.events).toHaveLength(1);
    expect(details.events[0]?.eventId).toBe('evnt_missing');
    expect(details.events[0]?.eventData.resumeAt).toBeInstanceOf(Date);
    agent.assertNoPendingInterceptors();
  });

  it('ignores a 412 payload whose events do not narrow to events', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/wait_created',
        method: 'POST',
      })
      .reply(
        412,
        JSON.stringify({
          success: false,
          code: 'precondition-failed',
          message: 'Run state is stale',
          events: [{ noEventId: true }],
        }),
        { headers: { 'content-type': 'application/json' } }
      );

    const error = await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: 'wait_created',
        specVersion: 5,
        correlationId: 'wait_1',
      },
      { token: 'test-token', dispatcher: agent }
    ).catch((err: unknown) => err);

    expect(PreconditionFailedError.is(error)).toBe(true);
    // Untrusted data on a failure path: dropped whole, so the client falls
    // back to the authoritative full reload.
    expect((error as PreconditionFailedError).details).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });

  it('forwards stateUpdatedAt in the frame meta (precondition guard)', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedMeta: Record<string, unknown> | undefined;
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/wait_created',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          const bytes = new Uint8Array(opts.body as ArrayBufferLike);
          const metaLen = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
          ).getUint32(0, false);
          capturedMeta = decode(bytes.subarray(4, 4 + metaLen)) as Record<
            string,
            unknown
          >;
          return encode({ wait: { waitId: 'wait_1' } });
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: 'wait_created',
        specVersion: 5,
        correlationId: 'wait_1',
        stateUpdatedAt: 1747742400000,
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.eventType).toBe('wait_created');
    expect(capturedMeta?.stateUpdatedAt).toBe(1747742400000);
    agent.assertNoPendingInterceptors();
  });

  it('forwards stateEventCount and stateCursor in the frame meta', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedMeta: Record<string, unknown> | undefined;
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/wait_created',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          const bytes = new Uint8Array(opts.body as ArrayBufferLike);
          const metaLen = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
          ).getUint32(0, false);
          capturedMeta = decode(bytes.subarray(4, 4 + metaLen)) as Record<
            string,
            unknown
          >;
          return encode({ wait: { waitId: 'wait_1' } });
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: 'wait_created',
        specVersion: 5,
        correlationId: 'wait_1',
        stateUpdatedAt: 1747742400000,
        stateEventCount: 12,
        stateCursor: 'eid:evnt_1',
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.stateEventCount).toBe(12);
    expect(capturedMeta?.stateCursor).toBe('eid:evnt_1');
    agent.assertNoPendingInterceptors();
  });

  it('omits stateEventCount and stateCursor from the frame meta when not set', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedMeta: Record<string, unknown> | undefined;
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/wait_created',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          const bytes = new Uint8Array(opts.body as ArrayBufferLike);
          const metaLen = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
          ).getUint32(0, false);
          capturedMeta = decode(bytes.subarray(4, 4 + metaLen)) as Record<
            string,
            unknown
          >;
          return encode({ wait: { waitId: 'wait_1' } });
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: 'wait_created',
        specVersion: 5,
        correlationId: 'wait_1',
        stateUpdatedAt: 1747742400000,
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect('stateEventCount' in (capturedMeta ?? {})).toBe(false);
    expect('stateCursor' in (capturedMeta ?? {})).toBe(false);
    agent.assertNoPendingInterceptors();
  });

  it('omits stateUpdatedAt from the frame meta when not set', async () => {
    const origin = 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    let capturedMeta: Record<string, unknown> | undefined;
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/wait_created',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          const bytes = new Uint8Array(opts.body as ArrayBufferLike);
          const metaLen = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
          ).getUint32(0, false);
          capturedMeta = decode(bytes.subarray(4, 4 + metaLen)) as Record<
            string,
            unknown
          >;
          return encode({ wait: { waitId: 'wait_1' } });
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: 'wait_created',
        specVersion: 5,
        correlationId: 'wait_1',
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.eventType).toBe('wait_created');
    expect('stateUpdatedAt' in (capturedMeta ?? {})).toBe(false);
    agent.assertNoPendingInterceptors();
  });
});

/**
 * `splitEventDataForV4` lifts allowlisted `eventData` fields into the frame
 * meta, and `buildPostFrameMeta` copies them onto the wire field-by-field.
 * `events.ts` spreads that meta into `CreateEventV4Input` (`...meta`), and a
 * spread bypasses TypeScript's excess-property check — so a field that
 * `buildPostFrameMeta` forgets to forward is dropped silently, with no build
 * error and no runtime warning.
 *
 * That is exactly how `encryptionPublicKey` went missing: the run's public key
 * was computed, put in the meta, spread into the v4 input, and then never
 * written to the frame. The server therefore never saw it, never stored it on
 * the run entity, and every cross-run writer fell back to the symmetric
 * envelope. The failure looked like "the server hasn't shipped the feature".
 */
describe('v4 POST frame meta forwards every field the splitter produces', () => {
  /** Decode `[u32_be meta_len][cbor_meta][u32_be body_len][body]`. */
  function decodeFrameMeta(body: unknown): Record<string, unknown> {
    const bytes =
      body instanceof Uint8Array
        ? body
        : new Uint8Array(body as ArrayBufferLike);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metaLen = view.getUint32(0, false);
    return decode(bytes.subarray(4, 4 + metaLen)) as Record<string, unknown>;
  }

  async function postAndCaptureMeta(
    data: Parameters<typeof splitEventDataForV4>[0]
  ) {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    let captured: Record<string, unknown> | undefined;
    agent
      .get(origin)
      .intercept({
        path: `/api/v4/runs/wrun_1/events/${data.eventType}`,
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          captured = decodeFrameMeta(opts.body);
          return encode({});
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    const { payload, meta } = splitEventDataForV4(data);
    await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: data.eventType,
        specVersion: 5,
        payload,
        ...meta,
      },
      { token: 'test-token', dispatcher: agent }
    );

    return { meta, wireMeta: captured ?? {} };
  }

  it('carries encryptionPublicKey on run_created', async () => {
    const key = 'ozGYxJP2piL8HTY0EukzPVQsyjo8x4L5ZA1xsFWllmA=';
    const { meta, wireMeta } = await postAndCaptureMeta({
      eventType: 'run_created',
      specVersion: 5,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'myWorkflow',
        encryptionPublicKey: key,
        input: new TextEncoder().encode('"in"'),
      },
    } as unknown as Parameters<typeof splitEventDataForV4>[0]);

    expect(meta.encryptionPublicKey).toBe(key);
    expect(wireMeta.encryptionPublicKey).toBe(key);
  });

  it('carries encryptionPublicKey on a resilient-start run_started', async () => {
    const key = 'QJI1dJ/7ZK8npKmpxjvCYPso0tS92pqjwTS3uAajd0E=';
    const { meta, wireMeta } = await postAndCaptureMeta({
      eventType: 'run_started',
      specVersion: 5,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'myWorkflow',
        encryptionPublicKey: key,
      },
    } as unknown as Parameters<typeof splitEventDataForV4>[0]);

    expect(meta.encryptionPublicKey).toBe(key);
    expect(wireMeta.encryptionPublicKey).toBe(key);
  });

  // Generic guard: whatever the splitter decides belongs in the frame meta must
  // actually reach the wire. This fails for ANY field a future change adds to
  // the splitter but forgets in buildPostFrameMeta, not just this one.
  it('drops no meta field between the splitter and the wire', async () => {
    const { meta, wireMeta } = await postAndCaptureMeta({
      eventType: 'run_created',
      specVersion: 5,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'myWorkflow',
        encryptionPublicKey: 'ozGYxJP2piL8HTY0EukzPVQsyjo8x4L5ZA1xsFWllmA=',
        attributes: { foo: 'bar' },
        allowReservedAttributes: true,
        executionContext: { traceCarrier: {} },
        input: new TextEncoder().encode('"in"'),
      },
    } as unknown as Parameters<typeof splitEventDataForV4>[0]);

    const metaKeys = Object.keys(meta);
    // Guard the guard: if the splitter stops producing fields this test is
    // vacuous, so require it to have produced a meaningful set.
    expect(metaKeys.length).toBeGreaterThan(3);
    expect(Object.keys(wireMeta)).toEqual(expect.arrayContaining(metaKeys));
  });
});
