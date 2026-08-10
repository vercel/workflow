import type { AnyEventRequest } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import {
  createWorkflowRunEvent,
  getWorkflowRunEvents,
  splitEventDataForV4,
} from './events.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';

const ORIGIN = 'https://vercel-workflow.com';

function mockAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

function decodePostedMeta(rawBody: unknown): Record<string, unknown> {
  const bytes =
    typeof rawBody === 'string'
      ? new TextEncoder().encode(rawBody)
      : new Uint8Array(rawBody as ArrayBufferLike);
  const metaLen = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(0, false);
  return decode(bytes.subarray(4, 4 + metaLen)) as Record<string, unknown>;
}

/**
 * Legacy (spec-version-1) runs predate event sourcing: the runtime still
 * posts hook_received (resumeHook) and wait_completed (wakeUpRun) for them
 * with `v1Compat: true`, expecting the legacy `/v1/runs/:id/events`
 * endpoint — NOT the v4 protocol. This locks in the fallback so the v4
 * migration can't silently break webhooks/waits on pre-event-sourcing runs.
 */
describe('createWorkflowRunEvent with v1Compat', () => {
  it.each([
    {
      eventType: 'hook_received' as const,
      data: {
        eventType: 'hook_received',
        correlationId: 'hook_1',
        specVersion: 1,
        eventData: { payload: { hello: 'world' } },
      },
      responseEventData: { payload: { hello: 'world' } },
    },
    {
      eventType: 'wait_completed' as const,
      data: {
        eventType: 'wait_completed',
        correlationId: 'wait_1',
        specVersion: 1,
        eventData: { resumeAt: '2026-06-10T00:00:00.000Z' },
      },
      responseEventData: { resumeAt: '2026-06-10T00:00:00.000Z' },
    },
  ])('posts $eventType to the legacy v1 events endpoint', async ({
    eventType,
    data,
    responseEventData,
  }) => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/runs/wrun_legacy/events', method: 'POST' })
      .reply(
        200,
        {
          eventId: 'evnt_legacy',
          runId: 'wrun_legacy',
          eventType,
          correlationId: data.correlationId,
          createdAt: '2026-06-10T00:00:00.000Z',
          specVersion: 1,
          eventData: responseEventData,
        },
        { headers: { 'content-type': 'application/json' } }
      );

    const result = await createWorkflowRunEvent(
      'wrun_legacy',
      data as AnyEventRequest,
      { v1Compat: true },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.event?.eventId).toBe('evnt_legacy');
    expect(result.event?.eventType).toBe(eventType);
    agent.assertNoPendingInterceptors();
  });

  it('rejects v1Compat without a runId for non-lifecycle events', async () => {
    await expect(
      createWorkflowRunEvent(
        null,
        {
          eventType: 'hook_received',
          correlationId: 'hook_1',
          specVersion: 1,
          eventData: { payload: {} },
        } as AnyEventRequest,
        { v1Compat: true },
        { token: 'test-token' }
      )
    ).rejects.toThrow(/requires a runId/);
  });
});

/**
 * The optimistic-concurrency precondition guard (see runtime/helpers.ts
 * withPreconditionRetry): a replay-context create carries `stateUpdatedAt`
 * (the ULID time of the latest event the runtime has loaded) so the backend
 * can reject a stale write with 412. Locks in that the field reaches the v4
 * frame meta, and is omitted entirely when the caller has no loaded snapshot.
 */
describe('createWorkflowRunEvent stateUpdatedAt wire field', () => {
  it('includes stateUpdatedAt in the v4 frame meta when provided', async () => {
    const agent = mockAgent();
    let capturedMeta: Record<string, unknown> | undefined;

    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          capturedMeta = decodePostedMeta(opts.body);
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

    await createWorkflowRunEvent(
      'wrun_1',
      { eventType: 'run_started', specVersion: 2 } as AnyEventRequest,
      { stateUpdatedAt: 1_700_000_000_000 },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.stateUpdatedAt).toBe(1_700_000_000_000);
    agent.assertNoPendingInterceptors();
  });

  it('omits stateUpdatedAt from the v4 frame meta when not provided', async () => {
    const agent = mockAgent();
    let capturedMeta: Record<string, unknown> | undefined;

    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          capturedMeta = decodePostedMeta(opts.body);
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

    await createWorkflowRunEvent(
      'wrun_1',
      { eventType: 'run_started', specVersion: 2 } as AnyEventRequest,
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect('stateUpdatedAt' in (capturedMeta ?? {})).toBe(false);
    agent.assertNoPendingInterceptors();
  });
});

/**
 * The split's meta allowlist IS the eventData wire contract on v4. The
 * type-level `assertEventDataWireContractExhaustive` guard in events.ts
 * fails the build if a schema field is routed to neither the payload body
 * nor the frame meta, so a *missing* field can't silently regress. These
 * runtime tests are the complement: they prove the fields that ARE routed
 * actually reach the frame meta with the right values and renames.
 *
 * This line's runtime does not serialize run/step errors through the
 * dehydration pipeline — it emits them as a plain string (step_failed /
 * step_retrying) or a `{ message, stack }` object (run_failed). The split
 * must carry these in the frame meta (not as an opaque body), or the v4
 * write path would throw on the non-Uint8Array error and every failure
 * event would die on the wire.
 */
describe('splitEventDataForV4 structured errors', () => {
  it('routes a step_failed string error + stack into the frame meta (no body)', () => {
    const stack = 'Error: boom\n    at fn (/app/step.js:10:5)';
    const { payload, meta } = splitEventDataForV4({
      eventType: 'step_failed',
      correlationId: 'step_1',
      specVersion: 2,
      eventData: { stepName: 'a-step', error: 'boom', stack },
    } as AnyEventRequest);

    expect(payload).toBeUndefined();
    expect(meta.error).toBe('boom');
    expect(meta.stack).toBe(stack);
    expect(meta.stepName).toBe('a-step');
  });

  it('routes a step_retrying string error + stack + retryAfter into the meta', () => {
    const stack = 'Error: flake\n    at fn (/app/step.js:11:5)';
    const retryAfter = new Date('2026-06-10T12:00:00.000Z');
    const { payload, meta } = splitEventDataForV4({
      eventType: 'step_retrying',
      correlationId: 'step_1',
      specVersion: 2,
      eventData: { stepName: 'a-step', error: 'flake', stack, retryAfter },
    } as AnyEventRequest);

    expect(payload).toBeUndefined();
    expect(meta.error).toBe('flake');
    expect(meta.stack).toBe(stack);
    expect(meta.retryAfter).toEqual(retryAfter);
  });

  it('routes a run_failed { message, stack } error object into the meta', () => {
    const error = { message: 'kaboom', stack: 'Error: kaboom\n    at main' };
    const { payload, meta } = splitEventDataForV4({
      eventType: 'run_failed',
      specVersion: 2,
      eventData: { error, errorCode: 'RUNTIME_ERROR' },
    } as AnyEventRequest);

    expect(payload).toBeUndefined();
    expect(meta.error).toEqual(error);
    expect(meta.errorCode).toBe('RUNTIME_ERROR');
    // run_failed carries its stack inside the error object, not as a sibling.
    expect(meta.stack).toBeUndefined();
  });

  it('keeps an already-dehydrated (Uint8Array) error on the body path', () => {
    // A runtime that DOES dehydrate errors hands the split a Uint8Array;
    // it must stream as the opaque frame body, untouched, with no meta.error.
    const bytes = new TextEncoder().encode('dehydrated-error-blob');
    const { payload, meta } = splitEventDataForV4({
      eventType: 'step_failed',
      correlationId: 'step_1',
      specVersion: 2,
      eventData: { stepName: 'a-step', error: bytes },
    } as AnyEventRequest);

    expect(payload).toBe(bytes);
    expect(meta.error).toBeUndefined();
  });

  it('still throws on a non-Uint8Array, non-error payload field', () => {
    // input/output/result/etc. are always the runtime's dehydrated bytes —
    // a plain value there is a real contract violation, not a structured
    // error, so the loud guard must stay.
    expect(() =>
      splitEventDataForV4({
        eventType: 'step_completed',
        correlationId: 'step_1',
        specVersion: 2,
        eventData: { stepName: 'a-step', result: { not: 'bytes' } },
      } as unknown as AnyEventRequest)
    ).toThrow(/must be a Uint8Array/);
  });
});

/**
 * The server's caps, mirrored so the assertions below state what they are
 * protecting: an error past either one is not merely fat on the wire, the
 * whole terminal event is refused and the run keeps no record of failing.
 */
const SERVER_MAX_META_BYTES = 64 * 1024;
const SERVER_MAX_STRUCTURED_ERROR_BYTES = 32 * 1024;

const byteLength = (value: string) =>
  new TextEncoder().encode(value).byteLength;

describe('splitEventDataForV4 oversized structured errors', () => {
  it('bounds a multi-MiB step_failed error message and stack', () => {
    const error = `boom: ${'x'.repeat(5 * 1024 * 1024)}`;
    const stack = `Error: boom\n${'    at fn (/app/step.js:10:5)\n'.repeat(50_000)}`;

    const { payload, meta } = splitEventDataForV4({
      eventType: 'step_failed',
      correlationId: 'step_1',
      specVersion: 2,
      eventData: { stepName: 'a-step', error, stack },
    } as AnyEventRequest);

    // Still the meta path (nothing to stream — the error is not dehydrated).
    expect(payload).toBeUndefined();
    expect(byteLength(meta.error as string)).toBeLessThan(
      SERVER_MAX_STRUCTURED_ERROR_BYTES
    );
    expect(byteLength(meta.stack as string)).toBeLessThan(
      SERVER_MAX_STRUCTURED_ERROR_BYTES
    );
    // The whole meta block, which is what the server actually rejected.
    expect(encode(meta).byteLength).toBeLessThan(SERVER_MAX_META_BYTES);
    // Diagnostic value survives: the head, plus a marker naming what was lost.
    expect(meta.error as string).toMatch(/^boom: x+/);
    expect(meta.error as string).toMatch(
      new RegExp(`truncated: ${byteLength(error)} bytes`)
    );
    expect(meta.stack as string).toMatch(/^Error: boom\n {4}at fn/);
    expect(meta.stack as string).toMatch(/truncated: \d+ bytes/);
  });

  it('bounds a multi-MiB step_retrying error while keeping retryAfter', () => {
    const retryAfter = new Date('2026-06-10T12:00:00.000Z');
    const { meta } = splitEventDataForV4({
      eventType: 'step_retrying',
      correlationId: 'step_1',
      specVersion: 2,
      eventData: {
        stepName: 'a-step',
        error: 'flake: '.repeat(1024 * 1024),
        stack: 'Error: flake\n    at fn'.repeat(100_000),
        retryAfter,
      },
    } as AnyEventRequest);

    expect(encode(meta).byteLength).toBeLessThan(SERVER_MAX_META_BYTES);
    expect(meta.retryAfter).toEqual(retryAfter);
  });

  it('bounds a multi-MiB run_failed error object, preserving its shape', () => {
    const { meta } = splitEventDataForV4({
      eventType: 'run_failed',
      specVersion: 2,
      eventData: {
        error: {
          message: 'kaboom: '.repeat(1024 * 1024),
          stack: 'Error: kaboom\n    at main'.repeat(200_000),
        },
        errorCode: 'RUNTIME_ERROR',
      },
    } as AnyEventRequest);

    // run_failed's consumers (deserializeError, the observability UI, the
    // server's structuredError materialization) read `message` / `stack` off
    // an object — truncation must not flatten it to a string.
    const error = meta.error as { message: string; stack: string };
    expect(error.message).toMatch(/^kaboom: /);
    expect(error.stack).toMatch(/^Error: kaboom\n {4}at main/);
    expect(encode(meta.error).byteLength).toBeLessThan(
      SERVER_MAX_STRUCTURED_ERROR_BYTES
    );
    expect(encode(meta).byteLength).toBeLessThan(SERVER_MAX_META_BYTES);
    expect(meta.errorCode).toBe('RUNTIME_ERROR');
  });

  it('keeps small sibling fields on a truncated run_failed error object', () => {
    const { meta } = splitEventDataForV4({
      eventType: 'run_failed',
      specVersion: 2,
      eventData: {
        error: {
          message: 'kaboom: '.repeat(1024 * 1024),
          stack: 'Error: kaboom',
          code: 'ERR_CUSTOM',
        },
      },
    } as AnyEventRequest);

    const error = meta.error as Record<string, unknown>;
    expect(error.code).toBe('ERR_CUSTOM');
    expect(error.stack).toBe('Error: kaboom');
    expect(encode(meta.error).byteLength).toBeLessThan(
      SERVER_MAX_STRUCTURED_ERROR_BYTES
    );
  });

  it('drops an oversized sibling field rather than blowing the budget', () => {
    // Truncating message/stack is not enough when the bulk is somewhere
    // else on the object; the bound still has to hold.
    const { meta } = splitEventDataForV4({
      eventType: 'run_failed',
      specVersion: 2,
      eventData: {
        error: {
          message: 'kaboom',
          stack: 'Error: kaboom',
          responseBody: 'y'.repeat(3 * 1024 * 1024),
        },
      },
    } as AnyEventRequest);

    const error = meta.error as Record<string, unknown>;
    expect(error).toEqual({ message: 'kaboom', stack: 'Error: kaboom' });
    expect(encode(meta.error).byteLength).toBeLessThan(
      SERVER_MAX_STRUCTURED_ERROR_BYTES
    );
  });

  it('leaves an in-budget error byte-identical', () => {
    // The overwhelmingly common case must be untouched: same value, same
    // wire bytes as before the bound existed.
    const error = 'x'.repeat(8 * 1024);
    const stack = `Error: boom\n${'    at fn (/app/step.js:10:5)\n'.repeat(20)}`;
    const { meta } = splitEventDataForV4({
      eventType: 'step_failed',
      correlationId: 'step_1',
      specVersion: 2,
      eventData: { stepName: 'a-step', error, stack },
    } as AnyEventRequest);

    expect(meta.error).toBe(error);
    expect(meta.stack).toBe(stack);
  });

  it('truncates on a code-point boundary', () => {
    // A byte-wise slice through a 4-byte emoji would leave a mojibake tail
    // (or a lone surrogate) in the message the user reads.
    const { meta } = splitEventDataForV4({
      eventType: 'step_failed',
      correlationId: 'step_1',
      specVersion: 2,
      eventData: { stepName: 'a-step', error: '😀'.repeat(1024 * 1024) },
    } as AnyEventRequest);

    const error = meta.error as string;
    expect(error).not.toContain('�');
    expect(error).toMatch(/^😀+/);
    expect(byteLength(error)).toBeLessThan(SERVER_MAX_STRUCTURED_ERROR_BYTES);
  });
});

describe('createWorkflowRunEvent oversized error frame', () => {
  it('posts a step_failed frame whose meta block stays under the server cap', async () => {
    const agent = mockAgent();
    let capturedMeta: Record<string, unknown> | undefined;
    let capturedMetaBytes = 0;

    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/step_failed',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          capturedMeta = decodePostedMeta(opts.body);
          capturedMetaBytes = encode(capturedMeta).byteLength;
          return encode({});
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:04.000Z',
          },
        }
      );

    await createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'step_failed',
        correlationId: 'step_1',
        specVersion: 2,
        eventData: {
          stepName: 'a-step',
          error: 'boom: '.repeat(1024 * 1024),
          stack: 'Error: boom\n    at fn'.repeat(200_000),
          deploymentId: 'dpl_1',
          workflowName: 'a-workflow',
        },
      } as AnyEventRequest,
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMetaBytes).toBeGreaterThan(0);
    expect(capturedMetaBytes).toBeLessThan(SERVER_MAX_META_BYTES);
    expect(byteLength(capturedMeta?.error as string)).toBeLessThan(
      SERVER_MAX_STRUCTURED_ERROR_BYTES
    );
    expect(byteLength(capturedMeta?.stack as string)).toBeLessThan(
      SERVER_MAX_STRUCTURED_ERROR_BYTES
    );
    agent.assertNoPendingInterceptors();
  });
});

describe('splitEventDataForV4 hook fields', () => {
  it('routes hook_created token + isWebhook into the frame meta', () => {
    // The runtime marks webhook hooks via eventData.isWebhook; the backend
    // reads it to reject public-webhook-endpoint resumption. Dropping it
    // from the wire silently breaks that — guard the routing here.
    const { meta } = splitEventDataForV4({
      eventType: 'hook_created',
      correlationId: 'hook_1',
      specVersion: 2,
      eventData: {
        token: 'tok_1',
        metadata: new TextEncoder().encode('{}'),
        isWebhook: true,
      },
    } as AnyEventRequest);

    expect(meta.hookToken).toBe('tok_1');
    expect(meta.hookIsWebhook).toBe(true);
  });
});

describe('createWorkflowRunEvent response coercion', () => {
  it('sends occurredAt in the v4 frame meta', async () => {
    const agent = mockAgent();
    const occurredAt = new Date('2026-06-10T00:00:03.000Z');
    let capturedMeta: Record<string, unknown> | undefined;

    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          capturedMeta = decodePostedMeta(opts.body);
          return encode({
            run: {
              runId: 'wrun_1',
              status: 'running',
              startedAt: new Date('2026-06-10T00:00:04.000Z'),
            },
          });
        },
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:04.000Z',
          },
        }
      );

    await createWorkflowRunEvent(
      'wrun_1',
      { eventType: 'run_started', specVersion: 2 } as AnyEventRequest,
      { occurredAt },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.occurredAt).toBeInstanceOf(Date);
    expect((capturedMeta?.occurredAt as Date).getTime()).toBe(
      occurredAt.getTime()
    );
    agent.assertNoPendingInterceptors();
  });

  it('coerces ISO-string dates in the returned event and preloaded events', async () => {
    // Persisted events store nested eventData dates as ISO strings
    // (the backend's entity layer converts Date → toISOString on write with
    // no inverse getter). The run_started TTFB preload reads events back
    // from a query, so the POST response's `event`/`events` need the same
    // EventSchema coercion as the GET/LIST path — the runtime calls
    // .getTime() on wait_created.resumeAt during replay.
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
      })
      .reply(
        200,
        encode({
          run: {
            runId: 'wrun_1',
            status: 'running',
            startedAt: new Date('2026-06-10T00:00:01.000Z'),
          },
          event: {
            eventId: 'evnt_2',
            runId: 'wrun_1',
            eventType: 'run_started',
            createdAt: '2026-06-10T00:00:01.000Z',
            occurredAt: '2026-06-10T00:00:00.500Z',
            eventData: {},
          },
          events: [
            {
              eventId: 'evnt_3',
              runId: 'wrun_1',
              eventType: 'wait_created',
              correlationId: 'wait_1',
              createdAt: '2026-06-10T00:00:02.000Z',
              occurredAt: '2026-06-10T00:00:01.500Z',
              specVersion: 2,
              eventData: { resumeAt: '2026-06-10T01:00:00.000Z' },
            },
          ],
          cursor: 'cursor-1',
          hasMore: false,
        }),
        {
          headers: {
            'x-wf-event-id': 'evnt_2',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:01.000Z',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      { eventType: 'run_started', specVersion: 2 } as AnyEventRequest,
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.event?.createdAt).toBeInstanceOf(Date);
    expect(result.event?.occurredAt).toBeInstanceOf(Date);
    const preloaded = result.events?.[0] as {
      createdAt: Date;
      occurredAt: Date;
      eventData: { resumeAt: Date };
    };
    expect(preloaded.createdAt).toBeInstanceOf(Date);
    expect(preloaded.occurredAt).toBeInstanceOf(Date);
    expect(preloaded.eventData.resumeAt).toBeInstanceOf(Date);
    expect(preloaded.eventData.resumeAt.getTime()).toBe(
      new Date('2026-06-10T01:00:00.000Z').getTime()
    );
    agent.assertNoPendingInterceptors();
  });

  it('threads the wait entity through to the EventResult', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/wait_created',
        method: 'POST',
      })
      .reply(
        200,
        encode({
          event: {
            eventId: 'evnt_4',
            runId: 'wrun_1',
            eventType: 'wait_created',
            correlationId: 'wait_1',
            createdAt: '2026-06-10T00:00:00.000Z',
            eventData: { resumeAt: '2026-06-10T01:00:00.000Z' },
          },
          wait: {
            waitId: 'wait_1',
            runId: 'wrun_1',
            status: 'pending',
          },
        }),
        {
          headers: {
            'x-wf-event-id': 'evnt_4',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'wait_created',
        correlationId: 'wait_1',
        specVersion: 2,
        eventData: { resumeAt: new Date('2026-06-10T01:00:00.000Z') },
      } as AnyEventRequest,
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.wait).toMatchObject({ waitId: 'wait_1' });
    expect(
      (result.event as { eventData?: { resumeAt?: unknown } })?.eventData
        ?.resumeAt
    ).toBeInstanceOf(Date);
    agent.assertNoPendingInterceptors();
  });
});

describe('createWorkflowRunEvent resolveData', () => {
  it("strips payload fields from the returned event when resolveData is 'none'", async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/step_completed',
        method: 'POST',
      })
      .reply(
        200,
        encode({
          event: {
            eventId: 'evnt_1',
            runId: 'wrun_1',
            eventType: 'step_completed',
            correlationId: 'step_1',
            createdAt: '2026-06-10T00:00:00.000Z',
            eventData: {
              result: new TextEncoder().encode('"payload-bytes"'),
              stepName: 'my-step',
            },
          },
        }),
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'step_completed',
        correlationId: 'step_1',
        specVersion: 2,
        eventData: {
          result: new TextEncoder().encode('"payload-bytes"'),
        },
      } as AnyEventRequest,
      { resolveData: 'none' },
      { token: 'test-token', dispatcher: agent }
    );

    // The Storage contract: a caller asking for resolveData 'none' must
    // not get payload bytes back — only entity metadata.
    const eventData = (result.event as { eventData?: Record<string, unknown> })
      ?.eventData;
    expect(eventData?.result).toBeUndefined();
    expect(eventData?.stepName).toBe('my-step');
    agent.assertNoPendingInterceptors();
  });
});

/**
 * Read-side complement to the structured-error write tests. The backend
 * materializes run/step errors into a StructuredError and stores it as a
 * CBOR-encoded ref; on the v4 read that ref's bytes arrive in the frame
 * body. `getWorkflowRunEvents` must decode them back to the { message,
 * stack } object the core step-event reducer reads directly — it has no
 * hydrate step for errors on this line, so raw bytes would surface as
 * "Unknown error" with no stack during replay.
 */
describe('getWorkflowRunEvents structured-error decode', () => {
  it('decodes a step_failed CBOR error body back into eventData.error', async () => {
    const agent = mockAgent();
    const structuredError = {
      message: 'boom',
      stack: 'Error: boom\n    at fn (/app/step.js:10:5)',
    };
    const frames = Buffer.concat([
      encodeFrame(
        {
          eventId: 'evnt_1',
          runId: 'wrun_1',
          eventType: 'step_failed',
          correlationId: 'step_1',
          createdAt: '2026-06-10T00:00:00.000Z',
          // `stack` is stripped from inline eventData server-side (it lives
          // inside the structuredError ref), so it is absent from the meta.
          eventData: { stepName: 'a-step' },
        },
        new Uint8Array(encode(structuredError))
      ),
      encodeFrame({ _end: 1 }, new Uint8Array(0)),
    ]);

    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events',
        method: 'GET',
        // resolveData 'all' maps to remoteRefBehavior=resolve on the wire.
        query: { remoteRefBehavior: 'resolve' },
      })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getWorkflowRunEvents(
      { runId: 'wrun_1', resolveData: 'all' },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.data).toHaveLength(1);
    const eventData = (
      result.data[0] as { eventData?: Record<string, unknown> }
    ).eventData;
    // Decoded back to the object form — not the raw CBOR Uint8Array.
    expect(eventData?.error).toEqual(structuredError);
    agent.assertNoPendingInterceptors();
  });
});

describe('getWorkflowRunEvents remoteRefBehavior mapping', () => {
  // A v4 LIST response: one run_created frame (with payload body) + sentinel.
  function listResponse(body: Uint8Array): Buffer {
    return Buffer.concat([
      encodeFrame(
        {
          eventId: 'evnt_1',
          runId: 'wrun_1',
          eventType: 'run_created',
          createdAt: '2026-06-10T00:00:00.000Z',
          eventData: {
            input: { _type: 'RemoteRef', _ref: 's3rf:wrun_1/input' },
            workflowName: 'wf',
          },
        },
        body
      ),
      encodeFrame({ _end: 1 }, new Uint8Array(0)),
    ]);
  }

  it("sends remoteRefBehavior=lazy for resolveData 'none' and strips any returned body", async () => {
    const agent = mockAgent();
    // The interceptor only matches when the request carries
    // ?remoteRefBehavior=lazy — so a missing/wrong param fails the request.
    // The reply still includes payload bytes, simulating a backend that
    // predates the flag: the adapter must strip them regardless.
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events',
        method: 'GET',
        query: { remoteRefBehavior: 'lazy' },
      })
      .reply(200, listResponse(new TextEncoder().encode('"payload"')), {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getWorkflowRunEvents(
      { runId: 'wrun_1', resolveData: 'none' },
      { token: 'test-token', dispatcher: agent }
    );

    const eventData = (
      result.data[0] as { eventData?: Record<string, unknown> }
    ).eventData;
    expect(eventData?.input).toBeUndefined();
    expect(eventData?.workflowName).toBe('wf');
    agent.assertNoPendingInterceptors();
  });

  it('sends remoteRefBehavior=resolve by default and splices the body bytes', async () => {
    const agent = mockAgent();
    const body = new TextEncoder().encode('"payload"');
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events',
        method: 'GET',
        query: { remoteRefBehavior: 'resolve' },
      })
      .reply(200, listResponse(body), {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    // No resolveData → defaults to 'all' → resolve.
    const result = await getWorkflowRunEvents(
      { runId: 'wrun_1' },
      { token: 'test-token', dispatcher: agent }
    );

    const eventData = (
      result.data[0] as { eventData?: Record<string, unknown> }
    ).eventData;
    expect(eventData?.input).toEqual(body);
    agent.assertNoPendingInterceptors();
  });
});
