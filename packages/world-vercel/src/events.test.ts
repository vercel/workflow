import type { AnyEventRequest } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { ulid } from 'ulid';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import {
  createWorkflowRunEvent,
  getWorkflowRunEvents,
  splitEventDataForV4,
} from './events.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import { encode as encodeRunId, REGION_IDS } from './run-id/index.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';

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
 */
describe('splitEventDataForV4 attribute fields', () => {
  it('carries attr_set changes/writer/allowReservedAttributes in the frame meta', () => {
    const { payload, meta } = splitEventDataForV4({
      eventType: 'attr_set',
      correlationId: 'attr_1',
      specVersion: 4,
      eventData: {
        changes: [
          { key: 'phase', value: 'done' },
          { key: 'stale', value: null },
        ],
        writer: { type: 'step', stepId: 'step_1', attempt: 2 },
        allowReservedAttributes: true,
      },
    } as AnyEventRequest);

    expect(payload).toBeUndefined();
    expect(meta.changes).toEqual([
      { key: 'phase', value: 'done' },
      { key: 'stale', value: null },
    ]);
    expect(meta.writer).toEqual({ type: 'step', stepId: 'step_1', attempt: 2 });
    expect(meta.allowReservedAttributes).toBe(true);
  });

  it('carries initial run attributes on run_created', () => {
    const { payload, meta } = splitEventDataForV4({
      eventType: 'run_created',
      specVersion: 4,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        input: new TextEncoder().encode('[]'),
        attributes: { sourceAtStart: 'api' },
      },
    } as AnyEventRequest);

    expect(payload).toBeInstanceOf(Uint8Array);
    expect(meta.attributes).toEqual({ sourceAtStart: 'api' });
    expect(meta.deploymentId).toBe('dpl_1');
    expect(meta.workflowName).toBe('wf');
  });

  it('splits resilient-start run_started input into the payload body', () => {
    const { payload, meta } = splitEventDataForV4({
      eventType: 'run_started',
      specVersion: 4,
      eventData: {
        input: new TextEncoder().encode('[]'),
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        attributes: { sourceAtStart: 'api' },
      },
    } as AnyEventRequest);

    expect(payload).toBeInstanceOf(Uint8Array);
    expect(meta.input).toBeUndefined();
    expect(meta.attributes).toEqual({ sourceAtStart: 'api' });
  });

  it('lifts workflowName into the frame meta on outcome events (step_completed/step_created), keeping the payload in the body', () => {
    // The backend keys payload refs by workflow name; carrying it in the
    // frame meta lets the v4 POST handler skip the per-step run lookup.
    const completed = splitEventDataForV4({
      eventType: 'step_completed',
      correlationId: 'step_1',
      specVersion: 4,
      eventData: {
        stepName: 's',
        workflowName: 'wf',
        result: new TextEncoder().encode('"ok"'),
      },
    } as AnyEventRequest);
    expect(completed.meta.workflowName).toBe('wf');
    // The result still travels as the opaque body, not in meta.
    expect(completed.payload).toBeInstanceOf(Uint8Array);
    expect(completed.meta.result).toBeUndefined();

    const created = splitEventDataForV4({
      eventType: 'step_created',
      correlationId: 'step_2',
      specVersion: 4,
      eventData: {
        stepName: 's',
        workflowName: 'wf',
        input: new TextEncoder().encode('[]'),
      },
    } as AnyEventRequest);
    expect(created.meta.workflowName).toBe('wf');
    expect(created.payload).toBeInstanceOf(Uint8Array);

    // The lazy inline start is the motivating hot-path event: it writes the
    // step `input` payload ref on the sequential path, so it must carry
    // workflowName to spare the backend the per-step run lookup.
    const started = splitEventDataForV4({
      eventType: 'step_started',
      correlationId: 'step_3',
      specVersion: 4,
      eventData: {
        stepName: 's',
        workflowName: 'wf',
        input: new TextEncoder().encode('[]'),
      },
    } as AnyEventRequest);
    expect(started.meta.workflowName).toBe('wf');
    expect(started.payload).toBeInstanceOf(Uint8Array);
    expect(started.meta.input).toBeUndefined();
  });

  it('carries the step_started ownerMessageId in the frame meta on the lazy path', () => {
    const { payload, meta } = splitEventDataForV4({
      eventType: 'step_started',
      correlationId: 'step_4',
      specVersion: 4,
      eventData: {
        stepName: 's',
        workflowName: 'wf',
        input: new TextEncoder().encode('[]'),
        ownerMessageId: 'msg_owner1',
      },
    } as AnyEventRequest);
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(meta.ownerMessageId).toBe('msg_owner1');
  });

  it('carries the ownerMessageId re-stamp on a bare (owned-recovery) step_started', () => {
    const { payload, meta } = splitEventDataForV4({
      eventType: 'step_started',
      correlationId: 'step_5',
      specVersion: 4,
      eventData: { stepName: 's', ownerMessageId: 'msg_owner1' },
    } as AnyEventRequest);
    expect(payload).toBeUndefined();
    expect(meta.ownerMessageId).toBe('msg_owner1');
  });

  it('omits ownerMessageId from meta on an unstamped bare step_started', () => {
    const { meta } = splitEventDataForV4({
      eventType: 'step_started',
      correlationId: 'step_6',
      specVersion: 4,
      eventData: { stepName: 's' },
    } as AnyEventRequest);
    expect(meta.ownerMessageId).toBeUndefined();
  });

  it('carries the run_cancelled cancelReason in the frame meta, not the payload', () => {
    const { payload, meta } = splitEventDataForV4({
      eventType: 'run_cancelled',
      specVersion: 4,
      eventData: { cancelReason: 'superseded by newer run' },
    } as AnyEventRequest);

    expect(payload).toBeUndefined();
    expect(meta.cancelReason).toBe('superseded by newer run');
  });

  it('omits cancelReason from meta when run_cancelled carries no reason', () => {
    const { payload, meta } = splitEventDataForV4({
      eventType: 'run_cancelled',
      specVersion: 4,
    } as AnyEventRequest);

    expect(payload).toBeUndefined();
    expect(meta.cancelReason).toBeUndefined();
  });

  it('carries latency telemetry in the frame meta on step terminal events', () => {
    const completed = splitEventDataForV4({
      eventType: 'step_completed',
      correlationId: 'step_1',
      specVersion: 4,
      eventData: {
        stepName: 's',
        workflowName: 'wf',
        result: new TextEncoder().encode('"ok"'),
        ttfs: 123,
        optimizations: ['turbo', 'lazyStepStart'],
      },
    } as AnyEventRequest);
    expect(completed.meta.ttfs).toBe(123);
    expect(completed.meta.stso).toBeUndefined();
    expect(completed.meta.optimizations).toEqual(['turbo', 'lazyStepStart']);

    const failed = splitEventDataForV4({
      eventType: 'step_failed',
      correlationId: 'step_2',
      specVersion: 4,
      eventData: {
        stepName: 's',
        error: new TextEncoder().encode('"boom"'),
        stso: 45,
        stepCount: 7,
        eventCount: 42,
        optimizations: [],
      },
    } as AnyEventRequest);
    expect(failed.meta.stso).toBe(45);
    expect(failed.meta.stepCount).toBe(7);
    expect(failed.meta.eventCount).toBe(42);
    expect(failed.meta.ttfs).toBeUndefined();
    expect(failed.meta.optimizations).toEqual([]);

    // Malformed values (non-number, non-string-array) are dropped, not sent.
    const malformed = splitEventDataForV4({
      eventType: 'step_completed',
      correlationId: 'step_3',
      specVersion: 4,
      eventData: {
        stepName: 's',
        result: new TextEncoder().encode('"ok"'),
        ttfs: 'fast',
        stepCount: 0,
        eventCount: 2.5,
        optimizations: [1, 2],
      },
    } as unknown as AnyEventRequest);
    expect(malformed.meta.ttfs).toBeUndefined();
    expect(malformed.meta.stepCount).toBeUndefined();
    expect(malformed.meta.eventCount).toBeUndefined();
    expect(malformed.meta.optimizations).toBeUndefined();
  });
});

describe('createWorkflowRunEvent response coercion', () => {
  it('accepts a current region-tagged run_created runId', async () => {
    const taggedRunId = `wrun_${encodeRunId(ulid(), REGION_IDS.sfo1)}`;
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v4/runs/${taggedRunId}/events/run_created`,
        method: 'POST',
      })
      .reply(
        200,
        encode({
          run: {
            runId: taggedRunId,
            status: 'running',
            startedAt: new Date('2026-06-10T00:00:01.000Z'),
          },
          event: {
            eventId: 'evnt_1',
            runId: taggedRunId,
            eventType: 'run_created',
            createdAt: '2026-06-10T00:00:01.000Z',
            eventData: {},
          },
        }),
        {
          headers: {
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': taggedRunId,
            'x-wf-created-at': '2026-06-10T00:00:01.000Z',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      taggedRunId,
      {
        eventType: 'run_created',
        specVersion: 4,
        eventData: {
          deploymentId: 'dpl_1',
          workflowName: 'wf',
          input: new TextEncoder().encode('[]'),
        },
      } as AnyEventRequest,
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.event?.runId).toBe(taggedRunId);
    agent.assertNoPendingInterceptors();
  });

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

/**
 * The v4 LIST sentinel carries a trailing `next` cursor even on the final
 * page (it doubles as the incremental-load resume point), so the runtime's
 * `while (hasMore)` replay loader must key off the server's explicit
 * `hasMore` — not `Boolean(next)` — to avoid one wasted empty-page request
 * per event-log load. Older servers omit the flag; the Boolean(next)
 * fallback preserves their (correct, if slower) behavior.
 */
describe('getWorkflowRunEvents hasMore mapping', () => {
  function mockListResponse(agent: MockAgent, sentinelMeta: object) {
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
      encodeFrame(sentinelMeta as Record<string, unknown>, new Uint8Array(0)),
    ]);
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events',
        method: 'GET',
        // These tests use the default resolveData ('all' → resolve), which
        // the adapter forwards as a query param; match it so the mock fires.
        query: { remoteRefBehavior: 'resolve' },
      })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });
  }

  it('honors an explicit hasMore:false even when a trailing cursor is present', async () => {
    const agent = mockAgent();
    mockListResponse(agent, { _end: 1, next: 'eid:last', hasMore: false });

    const result = await getWorkflowRunEvents(
      { runId: 'wrun_1' },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.data).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    // The cursor still rides along for incremental loads.
    expect(result.cursor).toBe('eid:last');
    agent.assertNoPendingInterceptors();
  });

  it('maps an explicit hasMore:true through', async () => {
    const agent = mockAgent();
    mockListResponse(agent, { _end: 1, next: 'cursor-2', hasMore: true });

    const result = await getWorkflowRunEvents(
      { runId: 'wrun_1' },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe('cursor-2');
  });

  it('falls back to Boolean(next) against a legacy server without the flag', async () => {
    const agent = mockAgent();
    mockListResponse(agent, { _end: 1, next: 'cursor-2' });

    const result = await getWorkflowRunEvents(
      { runId: 'wrun_1' },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe('cursor-2');
  });
});
