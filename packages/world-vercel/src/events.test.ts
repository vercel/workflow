import { Buffer } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { WorkflowWorldError } from '@workflow/errors';
import type { AnyEventRequest, CreateEventParams } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { ulid } from 'ulid';
import { MockAgent } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkflowRunEvent,
  getWorkflowRunEvents,
  splitEventDataForV4,
} from './events.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import { encode as encodeRunId, REGION_IDS } from './run-id/index.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
const STARTED_AT = new Date('2026-06-10T00:00:00.000Z');

function createEventBody(
  event: AnyEventRequest,
  entities: Record<string, unknown> = {}
) {
  return encode({
    event: {
      ...event,
      eventId: 'evnt_1',
      runId: 'wrun_1',
      createdAt: STARTED_AT,
    },
    ...entities,
  });
}

const runningRun = {
  runId: 'wrun_1',
  status: 'running',
  deploymentId: 'dpl_1',
  workflowName: 'workflow',
  startedAt: STARTED_AT,
  createdAt: STARTED_AT,
  updatedAt: STARTED_AT,
};

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

function runStartedResponse(events: Uint8Array[] = []): Buffer {
  return Buffer.concat([
    encodeFrame(
      {
        eventId: 'evnt_0',
        runId: 'wrun_1',
        eventType: 'run_created',
        createdAt: new Date('2026-06-09T23:59:59.000Z'),
        specVersion: 2,
        eventData: {
          deploymentId: 'dpl_1',
          workflowName: 'workflow',
        },
      },
      new Uint8Array()
    ),
    encodeFrame(
      {
        eventId: 'evnt_1',
        runId: 'wrun_1',
        eventType: 'run_started',
        createdAt: '2026-06-10T00:00:00.000Z',
        occurredAt: '2026-06-09T23:59:59.500Z',
        specVersion: 2,
        eventData: {},
      },
      new Uint8Array()
    ),
    ...events,
    encodeFrame(
      { _end: 1, next: 'eid:evnt_1', hasMore: false },
      new Uint8Array()
    ),
  ]);
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
 * A replay-context create names the position its decisions were made at:
 * `eventCount`, the highest event slot the runtime had loaded. Locks in that it
 * reaches the v4 frame meta under the wire name the backend reads, and that it
 * is omitted when the caller has no loaded snapshot — an unsent field leaves
 * the backend with no position to report a skipped span against.
 */
describe('createWorkflowRunEvent slot snapshot wire fields', () => {
  it('omits maxSlot from the v4 frame meta when no snapshot is provided', async () => {
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
          return runStartedResponse();
        },
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
            'x-wf-max-events': '10000',
          },
        }
      );

    await createWorkflowRunEvent(
      'wrun_1',
      { eventType: 'run_started', specVersion: 2 } as AnyEventRequest,
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect('maxSlot' in (capturedMeta ?? {})).toBe(false);
    agent.assertNoPendingInterceptors();
  });

  it('renames eventCount to maxSlot', async () => {
    // The runtime sends `eventCount` once a run's own ids are slot-shaped. It
    // cannot ride under that name: the v4 meta already has an unrelated
    // telemetry `eventCount`, so the backend would read a progress counter as
    // a log position.
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
          return runStartedResponse();
        },
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:00.000Z',
            'x-wf-max-events': '10000',
          },
        }
      );

    await createWorkflowRunEvent(
      'wrun_1',
      { eventType: 'run_started', specVersion: 2 } as AnyEventRequest,
      { eventCount: 9 },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.maxSlot).toBe(9);
    agent.assertNoPendingInterceptors();
  });

  it('never sends the snapshot on the legacy v1Compat path', async () => {
    // Pre-event-sourcing runs have no slot-numbered log to name a position
    // in, and the legacy endpoint has no field for one: the params are dropped
    // whole.
    const agent = mockAgent();
    let capturedBody = '';

    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v1/runs/wrun_legacy/events', method: 'POST' })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          capturedBody =
            typeof opts.body === 'string'
              ? opts.body
              : new TextDecoder().decode(opts.body as ArrayBufferLike);
          return {
            eventId: 'evnt_legacy',
            runId: 'wrun_legacy',
            eventType: 'wait_completed',
            correlationId: 'wait_1',
            createdAt: '2026-06-10T00:00:00.000Z',
            specVersion: 1,
            eventData: { resumeAt: '2026-06-10T00:00:00.000Z' },
          };
        },
        { headers: { 'content-type': 'application/json' } }
      );

    await createWorkflowRunEvent(
      'wrun_legacy',
      {
        eventType: 'wait_completed',
        correlationId: 'wait_1',
        specVersion: 1,
        eventData: { resumeAt: '2026-06-10T00:00:00.000Z' },
      } as AnyEventRequest,
      { v1Compat: true, eventCount: 7 },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedBody).toContain('wait_completed');
    expect(capturedBody).not.toContain('maxSlot');
    expect(capturedBody).not.toContain('eventCount');
    agent.assertNoPendingInterceptors();
  });
});

describe('createWorkflowRunEvent result contract', () => {
  it.each([
    {
      case: 'step_started without its step',
      eventType: 'step_started',
      data: {
        eventType: 'step_started',
        correlationId: 'step_1',
        specVersion: 2,
      },
      response: {},
      error: { name: 'WorkflowWorldError', code: 'SCHEMA_VALIDATION' },
    },
    {
      case: 'step_started without startedAt',
      eventType: 'step_started',
      data: {
        eventType: 'step_started',
        correlationId: 'step_1',
        specVersion: 2,
      },
      response: {
        step: {
          runId: 'wrun_1',
          stepId: 'step_1',
          stepName: 'step',
          status: 'running',
          attempt: 1,
          createdAt: STARTED_AT,
          updatedAt: STARTED_AT,
        },
      },
      error: { name: 'WorkflowWorldError', code: 'SCHEMA_VALIDATION' },
    },
  ])('rejects $case', async ({ eventType, data, response, error }) => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v4/runs/wrun_1/events/${eventType}`,
        method: 'POST',
      })
      .reply(200, createEventBody(data as AnyEventRequest, response), {
        headers: {
          'x-wf-event-id': 'evnt_1',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': '2026-06-10T00:00:00.000Z',
        },
      });

    await expect(
      createWorkflowRunEvent('wrun_1', data as AnyEventRequest, undefined, {
        token: 'test-token',
        dispatcher: agent,
      })
    ).rejects.toMatchObject(error);
    agent.assertNoPendingInterceptors();
  });
});

/** POSTs a v4 step_started with `params` and returns the decoded frame meta. */
async function postStepStartedMeta(
  params: CreateEventParams | undefined
): Promise<Record<string, unknown>> {
  const agent = mockAgent();
  let capturedMeta: Record<string, unknown> | undefined;

  agent
    .get(ORIGIN)
    .intercept({
      path: '/api/v4/runs/wrun_1/events/step_started',
      method: 'POST',
    })
    .reply(
      200,
      (opts: { body?: unknown }) => {
        capturedMeta = decodePostedMeta(opts.body);
        return createEventBody(
          {
            eventType: 'step_started',
            specVersion: 2,
            correlationId: 'step_1',
          },
          {
            step: {
              runId: 'wrun_1',
              stepId: 'step_1',
              stepName: 'step',
              status: 'running',
              attempt: 1,
              startedAt: STARTED_AT,
              createdAt: STARTED_AT,
              updatedAt: STARTED_AT,
            },
          }
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

  await createWorkflowRunEvent(
    'wrun_1',
    {
      eventType: 'step_started',
      specVersion: 2,
      correlationId: 'step_1',
    } as AnyEventRequest,
    params,
    { token: 'test-token', dispatcher: agent }
  );

  agent.assertNoPendingInterceptors();
  return capturedMeta ?? {};
}

describe('createWorkflowRunEvent computeInstanceId wire field', () => {
  const INSTANCE = 'cinst_01JZZZTESTINSTANCE00000001';

  it('includes computeInstanceId in the v4 frame meta when provided', async () => {
    const meta = await postStepStartedMeta({ computeInstanceId: INSTANCE });
    expect(meta.computeInstanceId).toBe(INSTANCE);
  });

  it('rides alongside requestId/vercelId rather than replacing it', async () => {
    // Independent dimensions: the pair is what distinguishes same-instance
    // from same-invocation execution.
    const meta = await postStepStartedMeta({
      requestId: 'iad1::abc-123-def',
      computeInstanceId: INSTANCE,
    });
    expect(meta.vercelId).toBe('iad1::abc-123-def');
    expect(meta.computeInstanceId).toBe(INSTANCE);
  });

  it('omits computeInstanceId from the v4 frame meta when not provided', async () => {
    const meta = await postStepStartedMeta(undefined);
    expect('computeInstanceId' in meta).toBe(false);
  });
});

describe('createWorkflowRunEvent replayDivergenceCount wire field', () => {
  it('carries recovery telemetry in v4 frame metadata', async () => {
    const agent = mockAgent();
    let capturedMeta: Record<string, unknown> | undefined;

    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_completed',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          capturedMeta = decodePostedMeta(opts.body);
          return createEventBody(
            {
              eventType: 'run_completed',
              specVersion: 2,
              eventData: { output: new Uint8Array() },
            },
            {
              run: {
                ...runningRun,
                status: 'completed',
                output: new Uint8Array(),
                completedAt: STARTED_AT,
              },
            }
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

    await createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'run_completed',
        specVersion: 2,
        eventData: { result: 'ok' },
      } as AnyEventRequest,
      {
        replayDivergenceCount: 2,
      },
      { token: 'test-token', dispatcher: agent }
    );

    expect(capturedMeta?.replayDivergenceCount).toBe(2);
    expect(capturedMeta?.eventData).toBeUndefined();
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
describe('splitEventDataForV4 structured fields', () => {
  it('carries atomic start Hook admission data as metadata', () => {
    const startHook = {
      token: 'order:123',
      tokenRetentionUntil: new Date('2026-09-01T00:00:00.000Z'),
    };
    const { meta } = splitEventDataForV4({
      eventType: 'run_created',
      specVersion: 5,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'workflow',
        input: new Uint8Array(),
        startHook,
      },
    });

    expect(meta.startHook).toEqual(startHook);
  });

  it('carries a Hook retention deadline in the frame meta', () => {
    const tokenRetentionUntil = new Date('2026-07-10T12:00:00.000Z');
    const { payload, meta } = splitEventDataForV4({
      eventType: 'hook_created',
      correlationId: 'hook_1',
      specVersion: 5,
      eventData: {
        token: 'order:123',
        tokenRetentionUntil,
      },
    } as AnyEventRequest);

    expect(payload).toBeUndefined();
    expect(meta.hookToken).toBe('order:123');
    expect(meta.hookTokenRetentionUntil).toEqual(tokenRetentionUntil);
  });

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
        rsfs: 88,
        finalSchedulingReplay: 12,
        optimizations: ['turbo', 'lazyStepStart'],
      },
    } as AnyEventRequest);
    expect(completed.meta.ttfs).toBe(123);
    expect(completed.meta.stso).toBeUndefined();
    expect(completed.meta.rsfs).toBe(88);
    expect(completed.meta.finalSchedulingReplay).toBe(12);
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
        rsfs: 'fast',
        finalSchedulingReplay: 'fast',
        stepCount: 0,
        eventCount: 2.5,
        optimizations: [1, 2],
      },
    } as unknown as AnyEventRequest);
    expect(malformed.meta.ttfs).toBeUndefined();
    expect(malformed.meta.rsfs).toBeUndefined();
    expect(malformed.meta.finalSchedulingReplay).toBeUndefined();
    expect(malformed.meta.stepCount).toBeUndefined();
    expect(malformed.meta.eventCount).toBeUndefined();
    expect(malformed.meta.optimizations).toBeUndefined();
  });
});

describe('createWorkflowRunEvent response coercion', () => {
  it('surfaces streamed event observer failures unchanged', async () => {
    const agent = mockAgent();
    const observerError = new WorkflowWorldError('observer failed', {
      code: 'TRANSPORT',
    });
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/run_started',
        method: 'POST',
      })
      .reply(200, runStartedResponse(), {
        headers: {
          'content-type': V4_FRAME_CONTENT_TYPE,
          'x-wf-event-id': 'evnt_1',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': STARTED_AT.toISOString(),
          'x-wf-max-events': '10000',
        },
      });

    await expect(
      createWorkflowRunEvent(
        'wrun_1',
        { eventType: 'run_started', specVersion: 2 } as AnyEventRequest,
        {
          replayEventObserver: () => {
            throw observerError;
          },
        },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toBe(observerError);
    agent.assertNoPendingInterceptors();
  });

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
            deploymentId: 'dpl_1',
            workflowName: 'wf',
            startedAt: new Date('2026-06-10T00:00:01.000Z'),
            createdAt: new Date('2026-06-10T00:00:01.000Z'),
            updatedAt: new Date('2026-06-10T00:00:01.000Z'),
          },
          event: {
            eventId: 'evnt_1',
            runId: taggedRunId,
            eventType: 'run_created',
            createdAt: '2026-06-10T00:00:01.000Z',
            eventData: {
              deploymentId: 'dpl_1',
              workflowName: 'wf',
              input: new TextEncoder().encode('[]'),
            },
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
          return runStartedResponse();
        },
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:04.000Z',
            'x-wf-max-events': '10000',
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
        runStartedResponse([
          encodeFrame(
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
            new Uint8Array()
          ),
        ]),
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-event-id': 'evnt_1',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:01.000Z',
            'x-wf-max-events': '10000',
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
    const preloaded = result.events?.[2] as {
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

  it('reconstructs out-of-order lifecycle events without decompressing input', async () => {
    const agent = mockAgent();
    const serializedInput = new TextEncoder().encode('"workflow input"');
    const compressedInput = gzipSync(serializedInput);
    const input = new Uint8Array(4 + compressedInput.byteLength);
    input.set(new TextEncoder().encode('gzip'));
    input.set(compressedInput, 4);
    agent
      .get(ORIGIN)
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
              eventId: 'evnt_2',
              runId: 'wrun_1',
              eventType: 'run_started',
              createdAt: new Date('2026-06-10T00:00:01.000Z'),
              specVersion: 5,
              eventData: {},
            },
            new Uint8Array()
          ),
          encodeFrame(
            {
              eventId: 'evnt_1',
              runId: 'wrun_1',
              eventType: 'run_created',
              createdAt: new Date('2026-06-10T00:00:00.000Z'),
              specVersion: 5,
              eventData: {
                deploymentId: 'dpl_1',
                workflowName: 'wf',
                input: { _type: 'RemoteRef', value: 'dbrf:unused' },
                executionContext: { region: 'iad1' },
                attributes: { initial: 'value' },
              },
            },
            input
          ),
          encodeFrame(
            {
              eventId: 'evnt_3',
              runId: 'wrun_1',
              eventType: 'attr_set',
              createdAt: new Date('2026-06-10T00:00:02.000Z'),
              specVersion: 5,
              eventData: {
                changes: [{ key: 'later', value: 'change' }],
                writer: { type: 'workflow' },
              },
            },
            new Uint8Array()
          ),
          encodeFrame(
            { _end: 1, next: 'eid:evnt_3', hasMore: false },
            new Uint8Array()
          ),
        ]),
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-event-id': 'evnt_2',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:01.000Z',
            'x-wf-max-events': '10000',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      { eventType: 'run_started', specVersion: 5 },
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.events?.map((event) => event.eventType)).toEqual([
      'run_started',
      'run_created',
      'attr_set',
    ]);
    expect(result.events?.[1].eventData?.input).toEqual(input);
    expect(result.run?.input).toEqual(input);
    expect(result.run).toMatchObject({
      deploymentId: 'dpl_1',
      workflowName: 'wf',
      executionContext: { region: 'iad1' },
      attributes: { initial: 'value', later: 'change' },
    });
    expect(result.cursor).toBe('eid:evnt_3');
    expect(result.hasMore).toBe(false);
    agent.assertNoPendingInterceptors();
  });

  it('classifies a run_started stream missing lifecycle events as a world schema error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        Buffer.concat([
          encodeFrame(
            {
              eventId: 'evnt_1',
              runId: 'wrun_1',
              eventType: 'run_started',
              createdAt: STARTED_AT,
              specVersion: 5,
              eventData: {},
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
      )
    );

    try {
      await expect(
        createWorkflowRunEvent(
          'wrun_1',
          { eventType: 'run_started', specVersion: 5 },
          undefined,
          { token: 'test-token' }
        )
      ).rejects.toMatchObject({
        name: 'WorkflowWorldError',
        code: 'SCHEMA_VALIDATION',
      });
    } finally {
      fetchSpy.mockRestore();
    }
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
            status: 'waiting',
            createdAt: STARTED_AT,
            updatedAt: STARTED_AT,
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
  it("returns the validated lazy ref when resolveData is 'none'", async () => {
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
              result: {
                _type: 'RemoteRef',
                _ref: 's3rf:wrun_1/evnt_1/result',
              },
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

    const eventData = (result.event as { eventData?: Record<string, unknown> })
      ?.eventData;
    expect(eventData?.result).toEqual({
      _type: 'RemoteRef',
      _ref: 's3rf:wrun_1/evnt_1/result',
    });
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
            deploymentId: 'dpl_1',
            workflowName: 'wf',
          },
        },
        body
      ),
      encodeFrame(
        { _end: 1, next: 'eid:evnt_1', hasMore: false },
        new Uint8Array(0)
      ),
    ]);
  }

  it("sends remoteRefBehavior=lazy for resolveData 'none'", async () => {
    const agent = mockAgent();
    // The interceptor only matches when the request carries
    // ?remoteRefBehavior=lazy — so a missing/wrong param fails the request.
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events',
        method: 'GET',
        query: { returnAll: 'true', remoteRefBehavior: 'lazy' },
      })
      .reply(200, listResponse(new Uint8Array()), {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getWorkflowRunEvents(
      { runId: 'wrun_1', resolveData: 'none' },
      { token: 'test-token', dispatcher: agent }
    );

    const eventData = (
      result.data[0] as { eventData?: Record<string, unknown> }
    ).eventData;
    expect(eventData?.input).toEqual({
      _type: 'RemoteRef',
      _ref: 's3rf:wrun_1/input',
    });
    expect(eventData?.workflowName).toBe('wf');
    agent.assertNoPendingInterceptors();
  });

  it('sends remoteRefBehavior=resolve and preserves opaque body bytes', async () => {
    const agent = mockAgent();
    const serialized = new TextEncoder().encode('devl["payload"]');
    const compressed = gzipSync(serialized);
    const body = new Uint8Array(4 + compressed.byteLength);
    body.set(new TextEncoder().encode('gzip'));
    body.set(compressed, 4);
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events',
        method: 'GET',
        query: { returnAll: 'true', remoteRefBehavior: 'resolve' },
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

  it('requests one server-paginated stream for runtime replay', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events',
        method: 'GET',
        query: { returnAll: 'true', remoteRefBehavior: 'resolve' },
      })
      .reply(200, listResponse(new Uint8Array()), {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    await getWorkflowRunEvents(
      { runId: 'wrun_1' },
      { token: 'test-token', dispatcher: agent }
    );

    agent.assertNoPendingInterceptors();
  });

  it('rejects a malformed event frame', async () => {
    const agent = mockAgent();
    const frames = Buffer.concat([
      encodeFrame(
        {
          eventId: 'evnt_1',
          runId: 'wrun_1',
          eventType: 'wait_created',
          correlationId: 'wait_1',
          createdAt: '2026-06-10T00:00:00.000Z',
          eventData: { resumeAt: 'not-a-date' },
        },
        new Uint8Array()
      ),
      encodeFrame({ _end: 1, hasMore: false }, new Uint8Array()),
    ]);
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events',
        method: 'GET',
        query: { returnAll: 'true', remoteRefBehavior: 'resolve' },
      })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    await expect(
      getWorkflowRunEvents(
        { runId: 'wrun_1' },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow();
    agent.assertNoPendingInterceptors();
  });
});

describe('getWorkflowRunEvents legacy structured-error compatibility', () => {
  const structuredErrorEventTypes = [
    'run_failed',
    'step_failed',
    'step_retrying',
  ] as const;

  function listResponse(
    eventType: (typeof structuredErrorEventTypes)[number],
    body: Uint8Array
  ): Buffer {
    return Buffer.concat([
      encodeFrame(
        {
          eventId: 'evnt_1',
          runId: 'wrun_1',
          eventType,
          ...(eventType === 'run_failed' ? {} : { correlationId: 'step_1' }),
          createdAt: '2026-06-10T00:00:00.000Z',
          eventData: {},
        },
        body
      ),
      encodeFrame(
        { _end: 1, next: 'eid:evnt_1', hasMore: false },
        new Uint8Array(0)
      ),
    ]);
  }

  async function readError(
    eventType: (typeof structuredErrorEventTypes)[number],
    body: Uint8Array
  ): Promise<unknown> {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events',
        method: 'GET',
        query: { returnAll: 'true', remoteRefBehavior: 'resolve' },
      })
      .reply(200, listResponse(eventType, body), {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getWorkflowRunEvents(
      { runId: 'wrun_1', resolveData: 'all' },
      { token: 'test-token', dispatcher: agent }
    );
    agent.assertNoPendingInterceptors();
    return (result.data[0] as { eventData?: Record<string, unknown> }).eventData
      ?.error;
  }

  it.each(
    structuredErrorEventTypes
  )('decodes a stable-line CBOR error for %s', async (eventType) => {
    const structuredError = {
      message: 'boom',
      stack: 'Error: boom\n    at fn (/app/step.js:10:5)',
    };

    await expect(
      readError(eventType, new Uint8Array(encode(structuredError)))
    ).resolves.toEqual(structuredError);
  });

  it.each([
    ['devalue', new TextEncoder().encode('devlserialized-error')],
    ['encrypted', new TextEncoder().encode('encrciphertext')],
  ])('preserves current %s error bytes', async (_name, body) => {
    await expect(readError('step_retrying', body)).resolves.toEqual(body);
  });

  it('leaves CBOR that is not a StructuredError as bytes', async () => {
    const body = new Uint8Array(encode({ value: 'not an error' }));
    await expect(readError('step_retrying', body)).resolves.toEqual(body);
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
          eventType: 'run_cancelled',
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
        // These tests omit the limit and use the default resolveData
        // ('all' → resolve); match both translated query params.
        query: { returnAll: 'true', remoteRefBehavior: 'resolve' },
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

  it('rejects a response without hasMore', async () => {
    const agent = mockAgent();
    mockListResponse(agent, { _end: 1, next: 'cursor-2' });

    await expect(
      getWorkflowRunEvents(
        { runId: 'wrun_1' },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow();
  });
});

/**
 * A correlation id names a step, hook or wait within *its* run: every
 * slot-numbered run numbers its own steps, so `step_…001` belongs to all of
 * them. The run id goes out on the request so the backend can answer for one
 * run, and the page is filtered again on arrival because a backend predating
 * that parameter answers across runs.
 */
describe('getWorkflowRunEvents by correlation id is scoped to the run', () => {
  it('sends runId and drops any foreign-run event a legacy backend returns', async () => {
    const agent = mockAgent();
    const event = (runId: string, eventId: string) =>
      encodeFrame(
        {
          eventId,
          runId,
          eventType: 'step_created',
          correlationId: 'step_001',
          createdAt: '2026-06-10T00:00:00.000Z',
          eventData: { stepName: 'testStep' },
        },
        new Uint8Array(0)
      );
    // What the pre-scope backend returns for this correlation id: the step of
    // the run we asked about plus the identically numbered step of another.
    const frames = Buffer.concat([
      event('wrun_1', 'evnt_1'),
      event('wrun_2', 'evnt_2'),
      encodeFrame(
        { _end: 1, next: 'eid:evnt_2', hasMore: true },
        new Uint8Array(0)
      ),
    ]);

    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/events',
        method: 'GET',
        query: {
          correlationId: 'step_001',
          runId: 'wrun_1',
          remoteRefBehavior: 'resolve',
        },
      })
      .reply(200, frames, {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });

    const result = await getWorkflowRunEvents(
      { correlationId: 'step_001', runId: 'wrun_1' },
      { token: 'test-token', dispatcher: agent }
    );

    // The interceptor only fires if runId reached the query string.
    agent.assertNoPendingInterceptors();
    expect(result.data.map((e) => e.eventId)).toEqual(['evnt_1']);
    // Pagination stays the backend's: a page that filters down to nothing is
    // still followed by the next one.
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toBe('eid:evnt_2');
  });
});

describe('createWorkflowRunEvent hook_received replay preload', () => {
  const RESUME_ID = 'resume-preload-1';
  const DIGEST = 'e'.repeat(64);
  const PAYLOAD = new TextEncoder().encode('"resume payload"');

  const preloadParams: CreateEventParams = {
    resumeId: RESUME_ID,
    resumePayloadDigest: DIGEST,
    preloadEvents: true,
  };

  function hookReceivedRequest() {
    return {
      eventType: 'hook_received',
      specVersion: 2,
      correlationId: 'hook_1',
      eventData: { token: 'tok-preload', payload: PAYLOAD },
    } as AnyEventRequest;
  }

  function concatFrames(frames: Uint8Array[]): Uint8Array {
    const total = frames.reduce((n, f) => n + f.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const f of frames) {
      out.set(f, off);
      off += f.byteLength;
    }
    return out;
  }

  function hookReplayFrames(): Uint8Array[] {
    return [
      encodeFrame(
        {
          eventId: 'evnt_1',
          runId: 'wrun_1',
          eventType: 'run_created',
          createdAt: new Date('2026-06-10T00:00:00.000Z'),
          specVersion: 2,
          eventData: {
            deploymentId: 'dpl_1',
            workflowName: 'wf',
            executionContext: { region: 'iad1' },
          },
        },
        new Uint8Array()
      ),
      encodeFrame(
        {
          eventId: 'evnt_2',
          runId: 'wrun_1',
          eventType: 'run_started',
          createdAt: new Date('2026-06-10T00:00:01.000Z'),
          specVersion: 2,
          eventData: {},
        },
        new Uint8Array()
      ),
      encodeFrame(
        {
          eventId: 'evnt_3',
          runId: 'wrun_1',
          eventType: 'hook_created',
          correlationId: 'hook_1',
          createdAt: new Date('2026-06-10T00:00:02.000Z'),
          specVersion: 2,
          eventData: { token: 'tok-preload' },
        },
        new Uint8Array()
      ),
      encodeFrame(
        {
          eventId: 'evnt_4',
          runId: 'wrun_1',
          eventType: 'hook_received',
          correlationId: 'hook_1',
          createdAt: new Date('2026-06-10T00:00:03.000Z'),
          specVersion: 2,
          resumeId: RESUME_ID,
          eventData: { token: 'tok-preload' },
        },
        PAYLOAD
      ),
      encodeFrame(
        { _end: 1, next: 'eid:evnt_4', hasMore: false },
        new Uint8Array()
      ),
    ];
  }

  function hookReplayStreamResponse(): Uint8Array {
    return concatFrames(hookReplayFrames());
  }

  it('decodes a streamed replay log into event + reconstructed run + page', async () => {
    const agent = mockAgent();
    let capturedMeta: Record<string, unknown> | undefined;
    agent
      .get(ORIGIN)
      .intercept({
        // The headers matcher proves the frame Accept was sent — an
        // unmatched request would leave the interceptor pending.
        path: '/api/v4/runs/wrun_1/events/hook_received',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          capturedMeta = decodePostedMeta(opts.body);
          return hookReplayStreamResponse();
        },
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-event-id': 'evnt_4',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:03.000Z',
            'x-wf-max-events': '10000',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      hookReceivedRequest(),
      preloadParams,
      { token: 'test-token', dispatcher: agent }
    );

    // The idempotency key + digest rode the frame meta. The request keeps
    // hook_received's lazy default: a supporting server owns frame-body
    // resolution regardless, and an older server then answers the CBOR
    // fallback without resolving a payload the runtime would discard.
    expect(capturedMeta?.resumeId).toBe(RESUME_ID);
    expect(capturedMeta?.resumePayloadDigest).toBe(DIGEST);
    expect(capturedMeta?.remoteRefBehavior).toBe('lazy');

    // The canonical event is the one the x-wf-event-id header names.
    expect(result.event?.eventId).toBe('evnt_4');
    expect(result.event?.eventType).toBe('hook_received');
    expect(result.event?.resumeId).toBe(RESUME_ID);
    expect(result.event?.eventData?.payload).toEqual(PAYLOAD);

    // The run is reconstructed from the streamed lifecycle events.
    expect(result.run).toMatchObject({
      runId: 'wrun_1',
      status: 'running',
      deploymentId: 'dpl_1',
      workflowName: 'wf',
      executionContext: { region: 'iad1' },
    });
    expect(result.run?.startedAt?.getTime()).toBe(
      new Date('2026-06-10T00:00:01.000Z').getTime()
    );

    expect(result.events?.map((event) => event.eventType)).toEqual([
      'run_created',
      'run_started',
      'hook_created',
      'hook_received',
    ]);
    expect(result.cursor).toBe('eid:evnt_4');
    expect(result.hasMore).toBe(false);
    expect(result.maxEvents).toBe(10000);
    agent.assertNoPendingInterceptors();
  });

  it('returns the page without a run when the stream lacks the lifecycle events', async () => {
    // A hook_received preload missing run_created / run_started is not
    // fatal: the write converged, so return the page without a run and let
    // the runtime take its safe fallback.
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/hook_received',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(
        200,
        concatFrames([
          encodeFrame(
            {
              eventId: 'evnt_4',
              runId: 'wrun_1',
              eventType: 'hook_received',
              correlationId: 'hook_1',
              createdAt: new Date('2026-06-10T00:00:03.000Z'),
              specVersion: 2,
              resumeId: RESUME_ID,
              eventData: { token: 'tok-preload' },
            },
            PAYLOAD
          ),
          encodeFrame(
            { _end: 1, next: 'eid:evnt_4', hasMore: false },
            new Uint8Array()
          ),
        ]),
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-event-id': 'evnt_4',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:03.000Z',
            'x-wf-max-events': '10000',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      hookReceivedRequest(),
      preloadParams,
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.event?.eventId).toBe('evnt_4');
    expect(result.run).toBeUndefined();
    expect(result.events).toHaveLength(1);
    expect(result.cursor).toBe('eid:evnt_4');
    agent.assertNoPendingInterceptors();
  });

  it('retries the atomic preload write past a transient transport failure', async () => {
    // The (runId, resumeId) claim makes the write idempotent-on-retry, so
    // createWorkflowRunEvent opts this shape into withEventPostRetry — an
    // ECONNRESET on the first attempt rides out in-process instead of
    // failing the delivery back to the queue.
    const agent = mockAgent();
    const reset = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/hook_received',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .replyWithError(reset);
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/hook_received',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(200, hookReplayStreamResponse(), {
        headers: {
          'content-type': V4_FRAME_CONTENT_TYPE,
          'x-wf-event-id': 'evnt_4',
          'x-wf-run-id': 'wrun_1',
          'x-wf-created-at': '2026-06-10T00:00:03.000Z',
          'x-wf-max-events': '10000',
        },
      });

    const result = await createWorkflowRunEvent(
      'wrun_1',
      hookReceivedRequest(),
      preloadParams,
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.event?.eventId).toBe('evnt_4');
    expect(result.events).toHaveLength(4);
    agent.assertNoPendingInterceptors();
  });

  it('keeps the CBOR result when the server does not stream (older server)', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/hook_received',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(
        200,
        encode({
          event: {
            eventId: 'evnt_4',
            runId: 'wrun_1',
            eventType: 'hook_received',
            correlationId: 'hook_1',
            createdAt: new Date('2026-06-10T00:00:03.000Z'),
            specVersion: 2,
            eventData: { token: 'tok-preload' },
          },
        }),
        {
          headers: {
            'content-type': 'application/cbor',
            'x-wf-event-id': 'evnt_4',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:03.000Z',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      hookReceivedRequest(),
      preloadParams,
      { token: 'test-token', dispatcher: agent }
    );

    // A successful write with no replay preload — the runtime falls back to
    // the run_started setup without posting the hook again.
    expect(result.event?.eventType).toBe('hook_received');
    expect(result.events).toBeUndefined();
    expect(result.run).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });

  it('continues a truncated preload after its last validated event', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/hook_received',
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(200, concatFrames(hookReplayFrames().slice(0, 2)), {
        headers: {
          'content-type': V4_FRAME_CONTENT_TYPE,
          'x-wf-event-id': 'evnt_4',
          'x-wf-max-events': '10000',
        },
      });
    agent
      .get(ORIGIN)
      .intercept({
        path: /\/api\/v4\/runs\/wrun_1\/events\?.*cursor=eid%3Aevnt_2/,
        method: 'GET',
      })
      .reply(200, concatFrames(hookReplayFrames().slice(2)), {
        headers: {
          'content-type': V4_FRAME_CONTENT_TYPE,
        },
      });

    const result = await createWorkflowRunEvent(
      'wrun_1',
      hookReceivedRequest(),
      preloadParams,
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.event?.eventId).toBe('evnt_4');
    expect(result.events).toHaveLength(4);
    expect(result.maxEvents).toBe(10000);
    agent.assertNoPendingInterceptors();
  });

  it('does not request the frame response without preloadEvents (producer write)', async () => {
    const agent = mockAgent();
    let capturedAccept: string | undefined;
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/hook_received',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { headers?: unknown }) => {
          const headers = opts.headers as
            | Record<string, string | undefined>
            | undefined;
          capturedAccept = headers?.accept ?? headers?.Accept;
          return encode({
            event: {
              eventId: 'evnt_4',
              runId: 'wrun_1',
              eventType: 'hook_received',
              correlationId: 'hook_1',
              createdAt: new Date('2026-06-10T00:00:03.000Z'),
              specVersion: 2,
              eventData: { token: 'tok-preload' },
            },
          });
        },
        {
          headers: {
            'content-type': 'application/cbor',
            'x-wf-event-id': 'evnt_4',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-06-10T00:00:03.000Z',
          },
        }
      );

    const result = await createWorkflowRunEvent(
      'wrun_1',
      hookReceivedRequest(),
      { resumeId: RESUME_ID, resumePayloadDigest: DIGEST },
      { token: 'test-token', dispatcher: agent }
    );

    // fetch fills a default `accept: */*`; what matters is the producer
    // never opts into the frame response.
    expect(capturedAccept ?? '').not.toContain(V4_FRAME_CONTENT_TYPE);
    expect(result.event?.eventType).toBe('hook_received');
    agent.assertNoPendingInterceptors();
  });
});
