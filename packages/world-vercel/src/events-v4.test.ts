import { Buffer } from 'node:buffer';
import {
  EntityConflictError,
  PreconditionFailedError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import type { AnyEventRequest } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitEventDataForV4 } from './events.js';
import {
  createWorkflowRunEventV4,
  createWorkflowRunStartedEventV4,
  getEventsByCorrelationIdV4,
  getEventV4,
  getWorkflowRunEventsV4,
  throwForErrorResponse,
} from './events-v4.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import {
  EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES,
  getEventsDispatcher,
} from './http-client.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const CREATED_AT = '2026-06-10T00:00:00.000Z';

function createEventBody(
  event: AnyEventRequest,
  entities: Record<string, unknown> = {}
) {
  return encode({
    event: {
      ...event,
      eventId: 'evnt_1',
      runId: 'wrun_1',
      createdAt: CREATED_AT,
    },
    ...entities,
  });
}

const runningRun = {
  runId: 'wrun_1',
  status: 'running',
  deploymentId: 'dpl_1',
  workflowName: 'workflow',
  startedAt: CREATED_AT,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

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

  it('reads message and code out of a CBOR body', () => {
    // A 412 that carries an event delta answers in CBOR so the delta's
    // payloads stay real bytes. Decoding it by content-type is what keeps the
    // message and code from being lost to a failed JSON.parse.
    try {
      throwForErrorResponse(
        412,
        { 'content-type': 'application/cbor' },
        encode({ message: 'Event log moved on' }),
        'createEvent',
        'http://x'
      );
      expect.unreachable();
    } catch (err) {
      expect(PreconditionFailedError.is(err)).toBe(true);
      expect((err as PreconditionFailedError).message).toBe(
        'Event log moved on'
      );
    }

    try {
      throwForErrorResponse(
        404,
        { 'content-type': 'application/cbor' },
        encode({ message: 'hook not found', code: 'not_found' }),
        'createEvent',
        'http://x'
      );
      expect.unreachable();
    } catch (err) {
      expect((err as WorkflowWorldError).code).toBe('not_found');
    }
  });

  it('keeps a CBOR 412 delta whose event payload is real bytes', () => {
    const result = new TextEncoder().encode('"done"');
    try {
      throwForErrorResponse(
        412,
        { 'content-type': 'application/cbor' },
        encode({
          message: 'Event log moved on',
          cursor: 'eid:evnt_missing',
          events: [
            {
              eventId: 'evnt_missing',
              runId: 'wrun_1',
              eventType: 'step_completed',
              correlationId: 'step_0',
              specVersion: 5,
              createdAt: '2026-06-10T00:00:00.000Z',
              eventData: { result },
            },
          ],
        }),
        'createEvent',
        'http://x'
      );
      expect.unreachable();
    } catch (err) {
      const details = (err as PreconditionFailedError).details as {
        events: Array<{ eventData: { result: unknown } }>;
        cursor?: string;
      };
      expect(details.cursor).toBe('eid:evnt_missing');
      // A JSON body would have mangled these bytes and the delta would have
      // been refused whole; CBOR round-trips them, so the client can merge.
      expect(details.events[0]?.eventData.result).toBeInstanceOf(Uint8Array);
      expect(
        new TextDecoder().decode(
          details.events[0]?.eventData.result as Uint8Array
        )
      ).toBe('"done"');
    }
  });

  it('falls back to the default message when a CBOR body will not decode', () => {
    // Undecodable bytes must not be appended to the message as mojibake.
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd]);
    try {
      throwForErrorResponse(
        500,
        { 'content-type': 'application/cbor' },
        garbage,
        'createEvent',
        'http://x'
      );
      expect.unreachable();
    } catch (err) {
      expect((err as WorkflowWorldError).message).toBe(
        'v4 createEvent failed: HTTP 500'
      );
    }
  });

  it('still parses a JSON body delivered as bytes', () => {
    try {
      throwForErrorResponse(
        404,
        { 'content-type': 'application/json' },
        new TextEncoder().encode('{"message":"hook not found"}'),
        'createEvent',
        'http://x'
      );
      expect.unreachable();
    } catch (err) {
      expect((err as WorkflowWorldError).message).toBe('hook not found');
    }
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
          eventData: {
            deploymentId: 'dpl_1',
            workflowName: 'workflow',
            input: null,
          },
        },
        body
      ),
      encodeFrame(
        { _end: 1, next: 'cursor-2', hasMore: false },
        new Uint8Array(0)
      ),
    ]);

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events?returnAll=true',
        method: 'GET',
      })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getWorkflowRunEventsV4(
      'wrun_1',
      {},
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: 'evnt_1',
      eventData: { input: body },
    });
    expect(result.cursor).toBe('cursor-2');
    agent.assertNoPendingInterceptors();
  });

  it.each([
    ['an unknown event type', { eventType: 'future_event', eventData: {} }],
    ['invalid event metadata', { eventType: 'run_created', eventData: {} }],
  ])('rejects %s', async (_description, meta) => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events?returnAll=true',
        method: 'GET',
      })
      .reply(
        200,
        Buffer.concat([
          encodeFrame(meta, new Uint8Array()),
          encodeFrame({ _end: 1, hasMore: false }, new Uint8Array()),
        ]),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );

    await expect(
      getWorkflowRunEventsV4(
        'wrun_1',
        {},
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow();
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
          eventData: {
            deploymentId: 'dpl_1',
            workflowName: 'workflow',
            input: null,
          },
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
      .intercept({
        path: '/api/v4/runs/wrun_1/events?returnAll=true',
        method: 'GET',
      })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getWorkflowRunEventsV4(
      'wrun_1',
      {},
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.cursor).toBe('eid:last');
    expect(result.hasMore).toBe(false);
  });

  it('rejects an end frame without hasMore', async () => {
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
      .intercept({
        path: '/api/v4/runs/wrun_1/events?returnAll=true',
        method: 'GET',
      })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    await expect(
      getWorkflowRunEventsV4(
        'wrun_1',
        {},
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow();
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
        eventData: {
          deploymentId: 'dpl_1',
          workflowName: 'workflow',
          input: null,
        },
      },
      new Uint8Array(0)
    );

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events?limit=500',
        method: 'GET',
      })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    await expect(
      getWorkflowRunEventsV4(
        'wrun_1',
        { limit: 500 },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow(/end-of-stream sentinel/);
  });

  it('resumes a truncated full stream after its last accepted event', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events?returnAll=true',
        method: 'GET',
      })
      .reply(
        200,
        encodeFrame(
          {
            eventId: 'evnt_1',
            runId: 'wrun_1',
            eventType: 'run_created',
            createdAt: CREATED_AT,
            eventData: {
              deploymentId: 'dpl_1',
              workflowName: 'workflow',
              input: null,
            },
          },
          new Uint8Array()
        ),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events?returnAll=true&cursor=eid%3Aevnt_1',
        method: 'GET',
      })
      .reply(
        200,
        Buffer.concat([
          encodeFrame(
            {
              eventId: 'evnt_2',
              runId: 'wrun_1',
              eventType: 'run_started',
              createdAt: CREATED_AT,
            },
            new Uint8Array()
          ),
          encodeFrame(
            { _end: 1, next: 'eid:evnt_2', hasMore: false },
            new Uint8Array()
          ),
        ]),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );

    const result = await getWorkflowRunEventsV4(
      'wrun_1',
      {},
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.events.map((event) => event.eventId)).toEqual([
      'evnt_1',
      'evnt_2',
    ]);
    expect(result.cursor).toBe('eid:evnt_2');
    expect(result.hasMore).toBe(false);
    agent.assertNoPendingInterceptors();
  });
});

/**
 * A correlation id names a step, hook or wait within *its* run, so the same
 * one appears in every slot-numbered run (`step_…001` is each run's first
 * step). The run id has to reach the backend for it to answer for one run.
 */
describe('getEventsByCorrelationIdV4 over HTTP', () => {
  it('sends the run id alongside the correlation id', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    const frames = Buffer.concat([
      encodeFrame(
        {
          eventId: 'evnt_1',
          runId: 'wrun_1',
          eventType: 'step_created',
          correlationId: 'step_001',
          createdAt: '2026-06-10T00:00:00.000Z',
          eventData: { stepName: 'testStep' },
        },
        new Uint8Array(0)
      ),
      encodeFrame({ _end: 1, hasMore: false }, new Uint8Array(0)),
    ]);

    // undici consults the matcher more than once per request (raw path and a
    // query-sorted normalization of it), so assert on the parsed query of
    // whatever it offered rather than on call counts or string equality.
    const requestedPaths: string[] = [];
    agent
      .get(origin)
      .intercept({
        path: (path) => {
          requestedPaths.push(path);
          return path.startsWith('/api/v4/events?');
        },
        method: 'GET',
      })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getEventsByCorrelationIdV4(
      'step_001',
      'wrun_1',
      { limit: 10 },
      { token: 'test-token', dispatcher: agent }
    );

    expect(requestedPaths.length).toBeGreaterThan(0);
    for (const path of requestedPaths) {
      const query = new URL(path, origin).searchParams;
      expect(query.get('correlationId')).toBe('step_001');
      expect(query.get('runId')).toBe('wrun_1');
      expect(query.get('limit')).toBe('10');
    }

    expect(result.events).toHaveLength(1);
    expect(result.events[0].runId).toBe('wrun_1');
    agent.assertNoPendingInterceptors();
  });
});

/**
 * getEventV4 returns after the first frame. The early return must cancel the
 * response body (releasing its undici socket) without corrupting the returned
 * value or hanging — the trailing frame below is never read.
 */
describe('getEventV4 over HTTP', () => {
  it('returns the first frame and stops reading the rest', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
          eventData: {
            deploymentId: 'dpl_1',
            workflowName: 'workflow',
            input: null,
          },
        },
        body
      ),
      // Trailing bytes the reader must never need.
      encodeFrame({ eventId: 'evnt_unused' }, new Uint8Array(8)),
    ]);

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/evnt_1?remoteRefBehavior=resolve',
        method: 'GET',
      })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const event = await getEventV4('wrun_1', 'evnt_1', 'resolve', {
      token: 'test-token',
      dispatcher: agent,
    });

    expect(event).toMatchObject({
      eventId: 'evnt_1',
      eventType: 'run_created',
      eventData: { input: body },
    });
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
      .intercept({
        path: '/api/v4/runs/wrun_1/events?returnAll=true',
        method: 'GET',
      })
      .reply(200, encodeFrame({ _end: 1, hasMore: false }, new Uint8Array(0)), {
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
      .reply(
        200,
        createEventBody(
          {
            eventType: 'step_completed',
            specVersion: 2,
            correlationId: 'step_1',
            eventData: { result: new Uint8Array() },
          },
          {
            step: {
              runId: 'wrun_1',
              stepId: 'step_1',
              stepName: 'step',
              status: 'completed',
              attempt: 1,
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
            },
          }
        ),
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': CREATED_AT,
          },
        }
      );

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

    expect(result.step).toMatchObject({ stepId: 'step_1' });
    agent.assertNoPendingInterceptors();
  });

  it('accepts hook_conflict from a hook_created request', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/hook_created',
        method: 'POST',
      })
      .reply(
        200,
        createEventBody({
          eventType: 'hook_conflict',
          specVersion: 5,
          correlationId: 'hook_1',
          eventData: { token: 'token', conflictingRunId: 'wrun_2' },
        }),
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': CREATED_AT,
          },
        }
      );

    const result = await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: 'hook_created',
        specVersion: 5,
        correlationId: 'hook_1',
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.event.eventType).toBe('hook_conflict');
    agent.assertNoPendingInterceptors();
  });

  it('requests and decodes the event stream for run_started', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();
    const input = new TextEncoder().encode('"workflow input"');

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(
        200,
        Buffer.concat([
          encodeFrame(
            {
              eventId: 'evnt_1',
              runId: 'wrun_1',
              eventType: 'run_created',
              createdAt: CREATED_AT,
              eventData: {
                deploymentId: 'dpl_1',
                workflowName: 'workflow',
                input: new Uint8Array(),
              },
            },
            input
          ),
          encodeFrame(
            {
              eventId: 'evnt_2',
              runId: 'wrun_1',
              eventType: 'run_started',
              createdAt: CREATED_AT,
            },
            new Uint8Array()
          ),
          encodeFrame(
            { _end: 1, next: 'eid:evnt_2', hasMore: false },
            new Uint8Array()
          ),
        ]),
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-event-id': 'evnt_2',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
            'x-wf-max-events': '10000',
          },
        }
      );

    const result = await createWorkflowRunStartedEventV4(
      {
        runId: 'wrun_1',
        specVersion: 5,
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.maxEvents).toBe(10000);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ eventData: { input } });
    expect(result.cursor).toBe('eid:evnt_2');
    expect(result.hasMore).toBe(false);
    agent.assertNoPendingInterceptors();
  });

  it('continues a truncated run_started stream after its last event', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();
    const observed: string[] = [];

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(
        200,
        encodeFrame(
          {
            eventId: 'evnt_1',
            runId: 'wrun_1',
            eventType: 'run_created',
            createdAt: CREATED_AT,
            eventData: {
              deploymentId: 'dpl_1',
              workflowName: 'workflow',
              input: null,
            },
          },
          new Uint8Array()
        ),
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-max-events': '10000',
          },
        }
      );
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events?returnAll=true&cursor=eid%3Aevnt_1',
        method: 'GET',
      })
      .reply(
        200,
        Buffer.concat([
          encodeFrame(
            {
              eventId: 'evnt_2',
              runId: 'wrun_1',
              eventType: 'run_started',
              createdAt: CREATED_AT,
            },
            new Uint8Array()
          ),
          encodeFrame(
            { _end: 1, next: 'eid:evnt_2', hasMore: false },
            new Uint8Array()
          ),
        ]),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );

    const result = await createWorkflowRunStartedEventV4(
      { runId: 'wrun_1', specVersion: 5 },
      { token: 'test-token', dispatcher: agent },
      (event) => observed.push(event.eventId)
    );

    expect(result.events.map((event) => event.eventId)).toEqual([
      'evnt_1',
      'evnt_2',
    ]);
    expect(result.hasMore).toBe(false);
    expect(observed).toEqual(['evnt_1', 'evnt_2']);
    agent.assertNoPendingInterceptors();
  });

  it('does not treat an event observer failure as stream truncation', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(
        200,
        Buffer.concat([
          encodeFrame(
            {
              eventId: 'evnt_1',
              runId: 'wrun_1',
              eventType: 'run_created',
              createdAt: CREATED_AT,
              eventData: {
                deploymentId: 'dpl_1',
                workflowName: 'workflow',
                input: null,
              },
            },
            new Uint8Array()
          ),
          encodeFrame(
            { _end: 1, next: 'eid:evnt_1', hasMore: false },
            new Uint8Array()
          ),
        ]),
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-max-events': '10000',
          },
        }
      );

    await expect(
      createWorkflowRunStartedEventV4(
        { runId: 'wrun_1', specVersion: 5 },
        { token: 'test-token', dispatcher: agent },
        () => {
          throw new Error('observer failed');
        }
      )
    ).rejects.toThrow('observer failed');
    agent.assertNoPendingInterceptors();
  });

  it('continues a graceful partial run_started stream from its sentinel cursor', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(
        200,
        Buffer.concat([
          encodeFrame(
            {
              eventId: 'evnt_1',
              runId: 'wrun_1',
              eventType: 'run_created',
              createdAt: CREATED_AT,
              eventData: {
                deploymentId: 'dpl_1',
                workflowName: 'workflow',
                input: null,
              },
            },
            new Uint8Array()
          ),
          encodeFrame(
            { _end: 1, next: 'eid:evnt_1', hasMore: true },
            new Uint8Array()
          ),
        ]),
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-max-events': '10000',
          },
        }
      );
    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events?returnAll=true&cursor=eid%3Aevnt_1',
        method: 'GET',
      })
      .reply(
        200,
        Buffer.concat([
          encodeFrame(
            {
              eventId: 'evnt_2',
              runId: 'wrun_1',
              eventType: 'run_started',
              createdAt: CREATED_AT,
            },
            new Uint8Array()
          ),
          encodeFrame(
            { _end: 1, next: 'eid:evnt_2', hasMore: false },
            new Uint8Array()
          ),
        ]),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );

    const result = await createWorkflowRunStartedEventV4(
      { runId: 'wrun_1', specVersion: 5 },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.events.map((event) => event.eventId)).toEqual([
      'evnt_1',
      'evnt_2',
    ]);
    expect(result.cursor).toBe('eid:evnt_2');
    expect(result.hasMore).toBe(false);
    agent.assertNoPendingInterceptors();
  });

  it('requires the event-stream response requested by run_started', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(origin)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(200, encode({ run: { runId: 'wrun_1', status: 'running' } }), {
        headers: {
          'content-type': 'application/cbor',
          'x-wf-event-id': 'evnt_2',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': '2026-06-10T00:00:00.000Z',
        },
      });

    await expect(
      createWorkflowRunStartedEventV4(
        {
          runId: 'wrun_1',
          specVersion: 5,
        },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow(
      `v4 createEvent: expected ${V4_FRAME_CONTENT_TYPE}, got application/cbor`
    );
    agent.assertNoPendingInterceptors();
  });

  it('keeps the CBOR response when run_started skips the preload', async () => {
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
        headers: (headers) => headers.accept === '*/*',
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
          return createEventBody(
            { eventType: 'run_started', specVersion: 5 },
            { run: runningRun }
          );
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    const result = await createWorkflowRunEventV4(
      {
        runId: 'wrun_1',
        eventType: 'run_started',
        specVersion: 5,
        skipPreload: true,
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.skipPreload).toBe(true);
    expect(result.run).toMatchObject({ status: 'running' });
    agent.assertNoPendingInterceptors();
  });

  it('surfaces the events a 412 carries as decoded PreconditionFailedError details', async () => {
    // A rejecting backend MAY return the events the client was missing, so the
    // replay restart needs no events.list round trip. They arrive as JSON, so
    // nested dates must come back as Date instances or the runtime crashes on
    // .getTime() deep in the replay.
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
        maxSlot: 3,
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

  it('ignores a 412 payload containing an unknown event type', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
          events: [
            {
              eventId: 'evnt_future',
              runId: 'wrun_1',
              eventType: 'future_event',
              createdAt: '2026-06-10T00:00:00.000Z',
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
      },
      { token: 'test-token', dispatcher: agent }
    ).catch((err: unknown) => err);

    expect(PreconditionFailedError.is(error)).toBe(true);
    // Untrusted data on a failure path: dropped whole, so the client falls
    // back to the authoritative full reload.
    expect((error as PreconditionFailedError).details).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });

  it('drops a 412 delta whose event payload came back JSON-mangled', async () => {
    // The 412 body is JSON, so a resolved payload field serializes to
    // `{type:'Buffer',data:[…]}` rather than bytes. EventSchema accepts that
    // shape, so it has to be rejected here or the runtime hydrates garbage
    // from it. One unusable event disqualifies the whole delta, including the
    // payload-less events beside it.
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
          cursor: 'eid:evnt_missing_2',
          events: [
            {
              eventId: 'evnt_missing_1',
              runId: 'wrun_1',
              eventType: 'wait_completed',
              specVersion: 5,
              createdAt: '2026-06-10T00:00:00.000Z',
              eventData: { resumeAt: '2026-06-10T00:00:05.000Z' },
            },
            {
              eventId: 'evnt_missing_2',
              runId: 'wrun_1',
              eventType: 'step_completed',
              correlationId: 'step_0',
              specVersion: 5,
              createdAt: '2026-06-10T00:00:01.000Z',
              // What JSON.stringify does to the resolved result bytes.
              eventData: {
                result: { type: 'Buffer', data: [100, 101, 118, 108] },
              },
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
        maxSlot: 3,
      },
      { token: 'test-token', dispatcher: agent }
    ).catch((err: unknown) => err);

    expect(PreconditionFailedError.is(error)).toBe(true);
    expect((error as PreconditionFailedError).details).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });

  it('keeps a 412 delta whose payload-bearing event has no payload', async () => {
    // A void step result carries no bytes at all, so there is nothing to
    // mangle and nothing to reject — the fast path must survive it.
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
          events: [
            {
              eventId: 'evnt_missing_1',
              runId: 'wrun_1',
              eventType: 'step_completed',
              correlationId: 'step_0',
              specVersion: 5,
              createdAt: '2026-06-10T00:00:01.000Z',
              eventData: { stepName: 'noop' },
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
        maxSlot: 3,
      },
      { token: 'test-token', dispatcher: agent }
    ).catch((err: unknown) => err);

    expect(PreconditionFailedError.is(error)).toBe(true);
    const details = (error as PreconditionFailedError).details as {
      events: Array<{ eventId: string }>;
    };
    expect(details.events.map((event) => event.eventId)).toEqual([
      'evnt_missing_1',
    ]);
    agent.assertNoPendingInterceptors();
  });

  it('forwards maxSlot in the frame meta', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
          return createEventBody({
            eventType: 'wait_created',
            specVersion: 5,
            correlationId: 'wait_1',
            eventData: { resumeAt: CREATED_AT },
          });
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
        specVersion: 6,
        correlationId: 'wait_1',
        maxSlot: 12,
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.maxSlot).toBe(12);
    agent.assertNoPendingInterceptors();
  });

  it('omits maxSlot from the frame meta when not set', async () => {
    const origin =
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
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
          return createEventBody({
            eventType: 'wait_created',
            specVersion: 5,
            correlationId: 'wait_1',
            eventData: { resumeAt: CREATED_AT },
          });
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

    expect('maxSlot' in (capturedMeta ?? {})).toBe(false);
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
          if (data.eventType !== 'run_started') {
            return createEventBody(data, { run: runningRun });
          }
          return Buffer.concat([
            encodeFrame(
              {
                eventId: 'evnt_0',
                runId: 'wrun_1',
                eventType: 'run_created',
                createdAt: CREATED_AT,
                eventData: {
                  deploymentId: 'dpl_1',
                  workflowName: 'workflow',
                  input: new Uint8Array(),
                },
              },
              new Uint8Array()
            ),
            encodeFrame(
              {
                eventId: 'evnt_1',
                runId: 'wrun_1',
                eventType: 'run_started',
                createdAt: CREATED_AT,
                eventData: {},
              },
              new Uint8Array()
            ),
            encodeFrame(
              { _end: 1, next: 'eid:evnt_1', hasMore: false },
              new Uint8Array()
            ),
          ]);
        },
        {
          headers: {
            ...(data.eventType === 'run_started'
              ? {
                  'content-type': V4_FRAME_CONTENT_TYPE,
                  'x-wf-max-events': '10000',
                }
              : {}),
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    const { payload, meta } = splitEventDataForV4(data);
    const input = { runId: 'wrun_1', specVersion: 5, payload, ...meta };
    const config = { token: 'test-token', dispatcher: agent };
    if (data.eventType === 'run_started') {
      await createWorkflowRunStartedEventV4(input, config);
    } else {
      await createWorkflowRunEventV4(
        { ...input, eventType: data.eventType },
        config
      );
    }

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

/**
 * The recycler in http-client only sees transport failures the v4 client
 * reports to it. This covers that wiring end to end: a `fetch()` that rejects
 * the way a wedged HTTP/2 session does must retire the shared events pool once
 * the failures reach the threshold. Without the `onTransportOutcome` hook in
 * `fetchV4` the recycler is never told anything and the pool lives forever.
 */
describe('v4 transport reports failures to the events recycler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Shape of a wedged-session rejection: `fetch` wraps undici's
  // InformationalError, so the code the recycler matches on is one `cause` down.
  const wedgedSessionError = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('HTTP/2: "stream timeout after 300"'), {
        code: 'UND_ERR_INFO',
      }),
    });

  it('rebuilds the shared pool after repeated stream timeouts', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(wedgedSessionError());

    // No `dispatcher` in the config: the request must resolve the shared one,
    // which is what the recycler owns.
    const before = getEventsDispatcher({ token: 'test-token' });

    for (let i = 0; i < EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES; i++) {
      await expect(
        getWorkflowRunEventsV4('wrun_1', {}, { token: 'test-token' })
      ).rejects.toThrow();
      // Still the same pool until the threshold is reached.
      if (i < EVENTS_RECYCLE_AFTER_CONSECUTIVE_FAILURES - 1) {
        expect(getEventsDispatcher({ token: 'test-token' })).toBe(before);
      }
    }

    expect(getEventsDispatcher({ token: 'test-token' })).not.toBe(before);
  });
});
