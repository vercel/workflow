import type { AnyEventRequest } from '@workflow/world';
import { encode } from 'cbor-x';
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

describe('createWorkflowRunEvent response coercion', () => {
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
            eventData: {},
          },
          events: [
            {
              eventId: 'evnt_3',
              runId: 'wrun_1',
              eventType: 'wait_created',
              correlationId: 'wait_1',
              createdAt: '2026-06-10T00:00:02.000Z',
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
    const preloaded = result.events?.[0] as {
      createdAt: Date;
      eventData: { resumeAt: Date };
    };
    expect(preloaded.createdAt).toBeInstanceOf(Date);
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
      .intercept({ path: '/api/v4/runs/wrun_1/events', method: 'GET' })
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
