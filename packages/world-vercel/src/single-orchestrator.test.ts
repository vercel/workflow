/**
 * The single-orchestrator (spec >= 9) half of the world-vercel event client:
 * every run-scoped event route on v5, the fence fields and step bookkeeping
 * in the frame meta, the list snapshot, the skipped-slot report flag, and the
 * 412 `in-band-superseded` refusal as its own error type.
 */
import {
  EntityConflictError,
  IN_BAND_SUPERSEDED_CODE,
  InBandSupersededError,
  PreconditionFailedError,
} from '@workflow/errors';
import {
  type AnyEventRequest,
  type CreateEventParams,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import {
  createWorkflowRunEvent,
  createWorkflowRunEventBatch,
  getEvent,
  getWorkflowRunEvents,
  splitEventDataForV4,
} from './events.js';
import { eventsApiVersion, throwForErrorResponse } from './events-v4.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import { createWorld } from './index.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
const CREATED_AT = new Date('2026-10-05T00:00:00.000Z');
const SPEC = SPEC_VERSION_SINGLE_ORCHESTRATOR;
/** The route a spec 9 run's events take. */
const EVENTS_API_VERSION = eventsApiVersion(SPEC);

function mockAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

function config(agent: MockAgent) {
  return { token: 'test-token', dispatcher: agent };
}

function decodeFrames(rawBody: unknown): Record<string, unknown>[] {
  const bytes =
    typeof rawBody === 'string'
      ? new TextEncoder().encode(rawBody)
      : new Uint8Array(rawBody as ArrayBufferLike);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metas: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const metaLen = view.getUint32(offset, false);
    metas.push(
      decode(bytes.subarray(offset + 4, offset + 4 + metaLen)) as Record<
        string,
        unknown
      >
    );
    offset += 4 + metaLen;
    const bodyLen = view.getUint32(offset, false);
    offset += 4 + bodyLen;
  }
  return metas;
}

function eventPath(runId: string, eventType: string) {
  return `/api/${EVENTS_API_VERSION}/runs/${runId}/events/${eventType}`;
}

function committed(
  event: AnyEventRequest,
  extra: Record<string, unknown> = {}
) {
  return encode({
    event: {
      ...event,
      eventId: 'evnt_5',
      runId: 'wrun_1',
      createdAt: CREATED_AT,
    },
    ...extra,
  });
}

/** POST one event and return the frame meta the backend received. */
async function postAndCaptureMeta(
  data: AnyEventRequest,
  params: CreateEventParams | undefined,
  response: Record<string, unknown> = {}
) {
  const agent = mockAgent();
  let meta: Record<string, unknown> | undefined;
  agent
    .get(ORIGIN)
    .intercept({ path: eventPath('wrun_1', data.eventType), method: 'POST' })
    .reply(
      200,
      (opts: { body?: unknown }) => {
        meta = decodeFrames(opts.body)[0];
        return committed(data, response);
      },
      { headers: { 'content-type': 'application/cbor' } }
    );
  const result = await createWorkflowRunEvent(
    'wrun_1',
    data,
    params,
    config(agent)
  );
  agent.assertNoPendingInterceptors();
  return { meta: meta as Record<string, unknown>, result };
}

describe('event routes by spec version', () => {
  it('routes a single-orchestrator run to v5 and every other run to v4', () => {
    expect(eventsApiVersion(SPEC)).toBe('v5');
    expect(eventsApiVersion(SPEC + 1)).toBe('v5');
    expect(eventsApiVersion(SPEC - 1)).toBe('v4');
    expect(eventsApiVersion(undefined)).toBe('v4');
    // A spec 9 executor's `run_started` on a run created below spec 9.
    expect(eventsApiVersion(SPEC - 1, SPEC)).toBe('v5');
  });

  it('reads a run from v4 unless the caller names a spec 9 run', async () => {
    for (const [specVersion, route] of [
      [undefined, 'v4'],
      [SPEC - 1, 'v4'],
      [SPEC, 'v5'],
    ] as const) {
      const agent = mockAgent();
      agent
        .get(ORIGIN)
        .intercept({
          path: `/api/${route}/runs/wrun_1/events?returnAll=true&remoteRefBehavior=resolve`,
          method: 'GET',
        })
        .reply(
          200,
          concat([
            eventFrame('evnt_1', 'run_created'),
            encodeFrame(
              { _end: 1, next: 'eid:evnt_1', hasMore: false },
              new Uint8Array()
            ),
          ]),
          { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
        );
      await getWorkflowRunEvents(
        { runId: 'wrun_1', ...(specVersion !== undefined && { specVersion }) },
        config(agent)
      );
      agent.assertNoPendingInterceptors();
    }
  });
});

describe('every run-scoped event route follows the run', () => {
  // The route is part of the backend contract: a run below spec 9 stays on
  // the routes earlier releases use, and a spec 9 run is only writable on v5.
  const cases = [
    { specVersion: SPEC - 1, route: 'v4' },
    { specVersion: SPEC, route: 'v5' },
  ] as const;

  function materialized(event: Record<string, unknown>) {
    return encode({
      event: {
        ...event,
        eventId: 'evnt_5',
        runId: 'wrun_1',
        createdAt: CREATED_AT,
      },
    });
  }
  const materializedHeaders = {
    'content-type': 'application/cbor',
    'x-wf-event-id': 'evnt_5',
    'x-wf-run-id': 'wrun_1',
    'x-wf-created-at': CREATED_AT.toISOString(),
  };

  it.each(cases)('single create at spec $specVersion goes to $route', async ({
    specVersion,
    route,
  }) => {
    const agent = mockAgent();
    const event = {
      eventType: 'step_completed',
      correlationId: 'step_1',
      specVersion,
      eventData: { result: new Uint8Array([1]) },
    } as AnyEventRequest;
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${route}/runs/wrun_1/events/step_completed`,
        method: 'POST',
      })
      .reply(200, materialized(event), { headers: materializedHeaders });
    await createWorkflowRunEvent('wrun_1', event, undefined, config(agent));
    agent.assertNoPendingInterceptors();
  });

  it.each(cases)('batch at spec $specVersion goes to $route', async ({
    specVersion,
    route,
  }) => {
    const agent = mockAgent();
    const event = {
      eventType: 'wait_created',
      correlationId: 'wait_1',
      specVersion,
      eventData: { resumeAt: CREATED_AT },
    } as AnyEventRequest;
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${route}/runs/wrun_1/events/batch`,
        method: 'POST',
      })
      .reply(
        200,
        encode({
          results: [
            {
              status: 200,
              event: {
                ...event,
                eventId: 'evnt_5',
                runId: 'wrun_1',
                createdAt: CREATED_AT,
              },
            },
          ],
        })
      );
    await createWorkflowRunEventBatch(
      'wrun_1',
      [{ event }] as Parameters<typeof createWorkflowRunEventBatch>[1],
      undefined,
      config(agent)
    );
    agent.assertNoPendingInterceptors();
  });

  it.each(
    cases
  )('hook_received preload at spec $specVersion goes to $route', async ({
    specVersion,
    route,
  }) => {
    const agent = mockAgent();
    const event = {
      eventType: 'hook_received',
      correlationId: 'hook_1',
      specVersion,
      eventData: { token: 'tok', payload: new Uint8Array([1]) },
    } as AnyEventRequest;
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${route}/runs/wrun_1/events/hook_received`,
        method: 'POST',
        headers: { accept: V4_FRAME_CONTENT_TYPE },
      })
      .reply(200, materialized(event), { headers: materializedHeaders });
    await createWorkflowRunEvent(
      'wrun_1',
      event,
      {
        resumeId: 'resume_1',
        resumePayloadDigest: 'e'.repeat(64),
        preloadEvents: true,
      },
      config(agent)
    );
    agent.assertNoPendingInterceptors();
  });

  it.each(cases)('get at spec $specVersion goes to $route', async ({
    specVersion,
    route,
  }) => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${route}/runs/wrun_1/events/evnt_1?remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(200, eventFrame('evnt_1', 'run_created'), {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });
    await getEvent('wrun_1', 'evnt_1', { specVersion }, config(agent));
    agent.assertNoPendingInterceptors();
  });

  it('reads an event from v4 when the caller does not name the run version', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/evnt_1?remoteRefBehavior=resolve',
        method: 'GET',
      })
      .reply(200, eventFrame('evnt_1', 'run_created'), {
        headers: { 'content-type': V4_FRAME_CONTENT_TYPE },
      });
    await getEvent('wrun_1', 'evnt_1', undefined, config(agent));
    agent.assertNoPendingInterceptors();
  });
});

describe('single-orchestrator meta fields on the v5 frame', () => {
  it('carries the fence fields and maxSlot on an in-band step_created, with inline and creatorMessageId', async () => {
    const { meta } = await postAndCaptureMeta(
      {
        eventType: 'step_created',
        correlationId: 'step_1',
        specVersion: SPEC,
        eventData: {
          stepName: 'add',
          input: new Uint8Array([1, 2, 3]),
          inline: true,
          creatorMessageId: 'msg_creator',
        },
      } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: 7, eventCount: 12 }
    );
    expect(meta).toMatchObject({
      eventType: 'step_created',
      specVersion: SPEC,
      stepName: 'add',
      inBand: true,
      expectedSeqInBand: 7,
      maxSlot: 12,
      inline: true,
      creatorMessageId: 'msg_creator',
    });
  });

  it('keeps inline: false rather than dropping the falsy value', async () => {
    const { meta } = await postAndCaptureMeta(
      {
        eventType: 'step_created',
        correlationId: 'step_1',
        specVersion: SPEC,
        eventData: {
          stepName: 'add',
          input: new Uint8Array([1]),
          inline: false,
        },
      } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: 1 }
    );
    expect(meta.inline).toBe(false);
  });

  it('carries stepName and attempt on an out-of-band step_started, and no expected count', async () => {
    const { meta, result } = await postAndCaptureMeta(
      {
        eventType: 'step_started',
        correlationId: 'step_1',
        specVersion: SPEC,
        eventData: { stepName: 'add', attempt: 2 },
      } as AnyEventRequest,
      { inBand: false }
    );
    expect(meta).toMatchObject({
      eventType: 'step_started',
      stepName: 'add',
      attempt: 2,
      inBand: false,
    });
    expect(meta).not.toHaveProperty('expectedSeqInBand');
    // A single-orchestrator run keeps no step entity, so none comes back.
    expect(result.step).toBeUndefined();
    expect(result.event.eventType).toBe('step_started');
  });

  it.each([
    'step_retrying',
    'step_failed',
  ] as const)('carries stepName and attempt on %s', async (eventType) => {
    const { meta } = await postAndCaptureMeta(
      {
        eventType,
        correlationId: 'step_1',
        specVersion: SPEC,
        eventData: {
          stepName: 'add',
          attempt: 3,
          error: new Uint8Array([9]),
        },
      } as AnyEventRequest,
      { inBand: false }
    );
    expect(meta).toMatchObject({ stepName: 'add', attempt: 3 });
  });

  it('carries creatorMessageId on an in-band step_retrying', async () => {
    const { meta } = await postAndCaptureMeta(
      {
        eventType: 'step_retrying',
        correlationId: 'step_1',
        specVersion: SPEC,
        eventData: {
          stepName: 'add',
          attempt: 1,
          error: new Uint8Array([9]),
          creatorMessageId: 'msg_orchestrator',
        },
      } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: 5 }
    );
    expect(meta).toMatchObject({
      stepName: 'add',
      attempt: 1,
      creatorMessageId: 'msg_orchestrator',
      inBand: true,
      expectedSeqInBand: 5,
    });
  });

  it('carries creatorMessageId on wait_created', async () => {
    const { meta } = await postAndCaptureMeta(
      {
        eventType: 'wait_created',
        correlationId: 'wait_1',
        specVersion: SPEC,
        eventData: { resumeAt: CREATED_AT, creatorMessageId: 'msg_creator' },
      } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: 4 }
    );
    expect(meta).toMatchObject({
      creatorMessageId: 'msg_creator',
      inBand: true,
      expectedSeqInBand: 4,
    });
  });

  it('carries expectedSeqInBand 0 rather than dropping it', async () => {
    const { meta } = await postAndCaptureMeta(
      {
        eventType: 'run_started',
        specVersion: SPEC,
      } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: 0, skipPreload: true },
      {
        run: {
          runId: 'wrun_1',
          status: 'running',
          deploymentId: 'dpl_1',
          workflowName: 'workflow',
          startedAt: CREATED_AT,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      }
    );
    expect(meta.expectedSeqInBand).toBe(0);
  });

  it('omits the fence fields when the caller sets neither', async () => {
    const { meta } = await postAndCaptureMeta(
      {
        eventType: 'wait_completed',
        correlationId: 'wait_1',
        specVersion: SPEC,
      } as AnyEventRequest,
      undefined
    );
    expect(meta).not.toHaveProperty('inBand');
    expect(meta).not.toHaveProperty('expectedSeqInBand');
  });

  // An inline step is created by its first start alone, so that start
  // carries everything its `step_created` would.
  it('carries an inline step creation on its in-band step_started, with the input as the body', async () => {
    const input = new Uint8Array([4, 5, 6]);
    const data = {
      eventType: 'step_started',
      correlationId: 'step_1',
      specVersion: SPEC,
      eventData: {
        stepName: 'add',
        workflowName: 'wf',
        input,
        inline: true,
        creatorMessageId: 'msg_creator',
        attempt: 1,
      },
    } as AnyEventRequest;
    const { meta } = await postAndCaptureMeta(data, {
      inBand: true,
      expectedSeqInBand: 3,
    });
    expect(meta).toMatchObject({
      eventType: 'step_started',
      stepName: 'add',
      workflowName: 'wf',
      inline: true,
      creatorMessageId: 'msg_creator',
      attempt: 1,
      inBand: true,
      expectedSeqInBand: 3,
    });
    expect(splitEventDataForV4(data).payload).toEqual(input);
  });

  it("reports the backend's reportIncomplete as hasMore, with the skipped-slot report", async () => {
    const reported = {
      eventId: 'evnt_4',
      runId: 'wrun_1',
      eventType: 'hook_received',
      correlationId: 'hook_1',
      createdAt: CREATED_AT,
      specVersion: SPEC,
      eventData: { token: 'tok' },
    };
    const { result } = await postAndCaptureMeta(
      {
        eventType: 'wait_completed',
        correlationId: 'wait_1',
        specVersion: SPEC,
      } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: 3, eventCount: 3 },
      {
        events: [reported],
        cursor: 'eid:evnt_4',
        hasMore: false,
        reportIncomplete: true,
        allocated: 1,
      }
    );
    expect(result.hasMore).toBe(true);
    expect(result).not.toHaveProperty('reportIncomplete');
    expect((result as { allocated?: number }).allocated).toBe(1);
    expect(result.events?.map((event) => event.eventId)).toEqual(['evnt_4']);
  });
});

describe('412 in-band-superseded', () => {
  const body = {
    success: false,
    error: IN_BAND_SUPERSEDED_CODE,
    message:
      'In-band write on run wrun_1 expected seqInBand 3, but the run is at 4.',
    seq: 9,
    seqInBand: 4,
  };

  async function postRejected(
    reply: { status: number; body: Uint8Array | string; contentType: string },
    interceptCount = 1
  ) {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: eventPath('wrun_1', 'step_created'), method: 'POST' })
      .reply(reply.status, reply.body, {
        headers: { 'content-type': reply.contentType },
      })
      .times(interceptCount);
    const error = await createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'step_created',
        correlationId: 'step_1',
        specVersion: SPEC,
        eventData: { stepName: 'add', input: new Uint8Array([1]) },
      } as AnyEventRequest,
      { inBand: true, expectedSeqInBand: 3 },
      config(agent)
    ).catch((err: unknown) => err);
    return { error, agent };
  }

  it('maps a JSON body to InBandSupersededError with the reported counters', async () => {
    const { error, agent } = await postRejected({
      status: 412,
      body: JSON.stringify(body),
      contentType: 'application/json',
    });
    expect(InBandSupersededError.is(error)).toBe(true);
    expect(PreconditionFailedError.is(error)).toBe(false);
    expect(error).toMatchObject({
      status: 412,
      code: IN_BAND_SUPERSEDED_CODE,
      seq: 9,
      seqInBand: 4,
    });
    agent.assertNoPendingInterceptors();
  });

  it('maps a CBOR body the same way', async () => {
    const { error } = await postRejected({
      status: 412,
      body: encode(body),
      contentType: 'application/cbor',
    });
    expect(InBandSupersededError.is(error)).toBe(true);
    expect(error).toMatchObject({ seq: 9, seqInBand: 4 });
  });

  it('is not retried in-process: a single request reaches the backend', async () => {
    // Two interceptors are registered; a retry would consume the second.
    const { error, agent } = await postRejected(
      {
        status: 412,
        body: JSON.stringify(body),
        contentType: 'application/json',
      },
      2
    );
    expect(InBandSupersededError.is(error)).toBe(true);
    expect(agent.pendingInterceptors()).toHaveLength(1);
  });

  it('keeps every other 412 a PreconditionFailedError', async () => {
    const { error } = await postRejected({
      status: 412,
      body: JSON.stringify({ error: 'precondition-failed', message: 'stale' }),
      contentType: 'application/json',
    });
    expect(PreconditionFailedError.is(error)).toBe(true);
    expect(InBandSupersededError.is(error)).toBe(false);
  });

  it('never reads a 409 carrying the same code as a fence refusal', async () => {
    const { error } = await postRejected({
      status: 409,
      body: JSON.stringify({ ...body }),
      contentType: 'application/json',
    });
    expect(EntityConflictError.is(error)).toBe(true);
    expect(InBandSupersededError.is(error)).toBe(false);
  });

  it('maps a WS reply body (bytes, no content type) whether CBOR or JSON', () => {
    for (const bytes of [
      encode(body),
      new TextEncoder().encode(JSON.stringify(body)),
    ]) {
      let thrown: unknown;
      try {
        throwForErrorResponse(412, {}, bytes, 'createEvent', 'wss://x');
      } catch (err) {
        thrown = err;
      }
      expect(InBandSupersededError.is(thrown)).toBe(true);
      expect(thrown).toMatchObject({ seq: 9, seqInBand: 4 });
    }
  });

  it('drops malformed counters rather than reporting them', () => {
    let thrown: unknown;
    try {
      throwForErrorResponse(
        412,
        { 'content-type': 'application/json' },
        JSON.stringify({ ...body, seq: -1, seqInBand: 'x' }),
        'createEvent',
        'https://x'
      );
    } catch (err) {
      thrown = err;
    }
    expect(InBandSupersededError.is(thrown)).toBe(true);
    expect((thrown as InBandSupersededError).seq).toBeUndefined();
    expect((thrown as InBandSupersededError).seqInBand).toBeUndefined();
  });
});

function eventFrame(eventId: string, eventType: string) {
  return encodeFrame(
    {
      eventId,
      runId: 'wrun_1',
      eventType,
      createdAt: CREATED_AT,
      specVersion: SPEC,
      ...(eventType === 'run_created'
        ? { eventData: { deploymentId: 'dpl_1', workflowName: 'workflow' } }
        : {}),
      ...(eventType === 'wait_completed' ? { correlationId: 'wait_1' } : {}),
    },
    new Uint8Array()
  );
}

function concat(parts: Uint8Array[]) {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

describe('list snapshot', () => {
  it('returns the sentinel snapshot with the page', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events?returnAll=true&remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(
        200,
        concat([
          eventFrame('evnt_1', 'run_created'),
          eventFrame('evnt_2', 'run_started'),
          encodeFrame(
            {
              _end: 1,
              next: 'eid:evnt_2',
              hasMore: false,
              snapshot: { seq: 2, seqInBand: 2 },
            },
            new Uint8Array()
          ),
        ]),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );
    const page = await getWorkflowRunEvents(
      { runId: 'wrun_1', specVersion: SPEC },
      config(agent)
    );
    expect(page.data).toHaveLength(2);
    expect(page.snapshot).toEqual({ seq: 2, seqInBand: 2 });
    agent.assertNoPendingInterceptors();
  });

  it('returns no snapshot when the backend sends none', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events?returnAll=true&remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(
        200,
        concat([
          eventFrame('evnt_1', 'run_created'),
          encodeFrame(
            { _end: 1, next: 'eid:evnt_1', hasMore: false },
            new Uint8Array()
          ),
        ]),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );
    const page = await getWorkflowRunEvents(
      { runId: 'wrun_1', specVersion: SPEC },
      config(agent)
    );
    expect(page).not.toHaveProperty('snapshot');
  });

  it('falls back to the snapshot headers when the end frame carries none', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events?returnAll=true&remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(
        200,
        concat([
          eventFrame('evnt_1', 'run_created'),
          encodeFrame(
            { _end: 1, next: 'eid:evnt_1', hasMore: false },
            new Uint8Array()
          ),
        ]),
        {
          headers: {
            'content-type': V4_FRAME_CONTENT_TYPE,
            'x-wf-snapshot-seq': '1',
            'x-wf-snapshot-seq-in-band': '1',
          },
        }
      );
    const page = await getWorkflowRunEvents(
      { runId: 'wrun_1', specVersion: SPEC },
      config(agent)
    );
    expect(page.snapshot).toEqual({ seq: 1, seqInBand: 1 });
  });

  // A malformed snapshot lists none rather than failing the page; on a
  // single-orchestrator run the runtime then refuses to write in-band from
  // that load, so a bad count never reaches a write.
  it('lists no snapshot when the end frame carries a malformed one', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events?returnAll=true&remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(
        200,
        concat([
          eventFrame('evnt_1', 'run_created'),
          encodeFrame(
            {
              _end: 1,
              next: 'eid:evnt_1',
              hasMore: false,
              snapshot: { seq: 1, seqInBand: -1 },
            },
            new Uint8Array()
          ),
        ]),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );
    const page = await getWorkflowRunEvents(
      { runId: 'wrun_1', specVersion: SPEC },
      config(agent)
    );
    expect(page.data).toHaveLength(1);
    expect(page.snapshot).toBeUndefined();
  });

  it('takes the snapshot of the response that completed a resumed full read', async () => {
    const agent = mockAgent();
    // First response is truncated before its sentinel: no snapshot from it.
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events?returnAll=true&remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(
        200,
        concat([
          eventFrame('evnt_1', 'run_created'),
          eventFrame('evnt_2', 'run_started'),
        ]),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events?returnAll=true&cursor=eid%3Aevnt_2&remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(
        200,
        concat([
          eventFrame('evnt_3', 'wait_completed'),
          encodeFrame(
            {
              _end: 1,
              next: 'eid:evnt_3',
              hasMore: false,
              snapshot: { seq: 3, seqInBand: 2 },
            },
            new Uint8Array()
          ),
        ]),
        { headers: { 'content-type': V4_FRAME_CONTENT_TYPE } }
      );
    const page = await getWorkflowRunEvents(
      { runId: 'wrun_1', specVersion: SPEC },
      config(agent)
    );
    expect(page.data.map((event) => event.eventId)).toEqual([
      'evnt_1',
      'evnt_2',
      'evnt_3',
    ]);
    expect(page.snapshot).toEqual({ seq: 3, seqInBand: 2 });
    agent.assertNoPendingInterceptors();
  });
});

describe('fenced batch', () => {
  const events = [
    {
      event: {
        eventType: 'step_created',
        correlationId: 'step_1',
        specVersion: SPEC,
        eventData: {
          stepName: 'a',
          input: new Uint8Array([1]),
          inline: false,
          creatorMessageId: 'msg_1',
        },
      },
    },
    {
      event: {
        eventType: 'wait_created',
        correlationId: 'wait_1',
        specVersion: SPEC,
        eventData: { resumeAt: CREATED_AT, creatorMessageId: 'msg_1' },
      },
    },
  ] as Parameters<typeof createWorkflowRunEventBatch>[1];

  it('stamps the same fence fields on every frame', async () => {
    const agent = mockAgent();
    let metas: Record<string, unknown>[] = [];
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events/batch`,
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          metas = decodeFrames(opts.body);
          return encode({
            results: events.map(({ event }, index) => ({
              status: 200,
              event: {
                ...event,
                eventId: `evnt_${index + 3}`,
                runId: 'wrun_1',
                createdAt: CREATED_AT,
              },
            })),
          });
        },
        { headers: { 'content-type': 'application/cbor' } }
      );
    const result = await createWorkflowRunEventBatch(
      'wrun_1',
      events,
      { inBand: true, expectedSeqInBand: 5, eventCount: 6 },
      config(agent)
    );
    expect(result.results.map((item) => item.status)).toEqual([200, 200]);
    expect(metas).toHaveLength(2);
    for (const meta of metas) {
      expect(meta).toMatchObject({
        inBand: true,
        expectedSeqInBand: 5,
        maxSlot: 6,
        creatorMessageId: 'msg_1',
      });
    }
    expect(metas[0]?.inline).toBe(false);
  });

  it('returns the top-level skipped-slot report and allocated count of an in-band batch', async () => {
    const agent = mockAgent();
    const reported = {
      eventId: 'evnt_3',
      runId: 'wrun_1',
      eventType: 'hook_received',
      correlationId: 'hook_1',
      createdAt: CREATED_AT,
      specVersion: SPEC,
      eventData: { token: 'tok' },
    };
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events/batch`,
        method: 'POST',
      })
      .reply(
        200,
        encode({
          results: events.map(({ event }, index) => ({
            status: 200,
            event: {
              ...event,
              eventId: `evnt_${index + 4}`,
              runId: 'wrun_1',
              createdAt: CREATED_AT,
            },
          })),
          events: [reported],
          reportIncomplete: false,
          allocated: 2,
        }),
        { headers: { 'content-type': 'application/cbor' } }
      );
    const result = await createWorkflowRunEventBatch(
      'wrun_1',
      events,
      { inBand: true, expectedSeqInBand: 5, eventCount: 2 },
      config(agent)
    );
    expect(result.events?.map((event) => event.eventId)).toEqual(['evnt_3']);
    expect(result.hasMore).toBeUndefined();
    expect(result).not.toHaveProperty('reportIncomplete');
    expect((result as { allocated?: number }).allocated).toBe(2);
  });

  it("reports an in-band batch's incomplete skipped-slot report as hasMore", async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events/batch`,
        method: 'POST',
      })
      .reply(
        200,
        encode({
          results: events.map(({ event }, index) => ({
            status: 200,
            event: {
              ...event,
              eventId: `evnt_${index + 4}`,
              runId: 'wrun_1',
              createdAt: CREATED_AT,
            },
          })),
          events: [],
          reportIncomplete: true,
          allocated: 2,
        }),
        { headers: { 'content-type': 'application/cbor' } }
      );
    const result = await createWorkflowRunEventBatch(
      'wrun_1',
      events,
      { inBand: true, expectedSeqInBand: 5, eventCount: 2 },
      config(agent)
    );
    expect(result.hasMore).toBe(true);
    expect(result).not.toHaveProperty('reportIncomplete');
  });

  it('throws InBandSupersededError when the batch was refused by the fence', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events/batch`,
        method: 'POST',
      })
      .reply(
        200,
        encode({
          results: events.map(() => ({
            status: 412,
            error: IN_BAND_SUPERSEDED_CODE,
            message: 'superseded',
          })),
        }),
        { headers: { 'content-type': 'application/cbor' } }
      );
    await expect(
      createWorkflowRunEventBatch(
        'wrun_1',
        events,
        { inBand: true, expectedSeqInBand: 5 },
        config(agent)
      )
    ).rejects.toSatisfy((err: unknown) => InBandSupersededError.is(err));
  });

  it('throws InBandSupersededError for a request-level 412 too', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events/batch`,
        method: 'POST',
      })
      .reply(
        412,
        JSON.stringify({ error: IN_BAND_SUPERSEDED_CODE, message: 'x' }),
        { headers: { 'content-type': 'application/json' } }
      );
    await expect(
      createWorkflowRunEventBatch(
        'wrun_1',
        events,
        { inBand: true, expectedSeqInBand: 5 },
        config(agent)
      )
    ).rejects.toSatisfy((err: unknown) => InBandSupersededError.is(err));
  });
});

describe('capabilities', () => {
  it('declares the in-band fence the runtime requires', () => {
    expect(createWorld().capabilities?.inBandFence).toBe(true);
  });
});
