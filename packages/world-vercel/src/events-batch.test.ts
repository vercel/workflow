import { Buffer } from 'node:buffer';
import type { BatchEventRequest } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { createWorkflowRunEventBatch } from './events.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

/**
 * POST /api/v4/runs/:runId/events/batch — the client wire half.
 *
 * What these tests pin down:
 *  - the request body is the events' single-POST frames back-to-back, in
 *    request order, with per-event meta and payload bytes and NO batch-level
 *    fence fields (the retired v2 design's expectedRunVersion / batchId /
 *    logicalCreatedAt must never reappear on the wire);
 *  - per-event results map through typed: successes validate against the
 *    same per-type schema as the single POST, failures pass through
 *    { status, error, message } untouched;
 *  - a malformed response (wrong results length, invalid item body) fails
 *    loudly as SCHEMA_VALIDATION rather than degrading into per-event
 *    failures;
 *  - the whole POST is idempotent-on-retry (batchIdempotent): a transient
 *    5xx is retried in-process regardless of the contained event types.
 */

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
const CREATED_AT = '2026-08-14T00:00:00.000Z';
const RUN_ID = 'wrun_1';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Slot-identity event id for `slot` (26-char zero-padded decimal body). */
const slotEventId = (slot: number): string =>
  `evnt_${String(slot).padStart(26, '0')}`;

function mockAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

/** Parse the concatenated v4 frames of a batch request body. */
function decodeBatchFrames(
  body: Uint8Array
): { meta: Record<string, unknown>; payload: Uint8Array }[] {
  const frames: { meta: Record<string, unknown>; payload: Uint8Array }[] = [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = 0;
  while (offset < body.byteLength) {
    const metaLen = view.getUint32(offset, false);
    const meta = decode(body.subarray(offset + 4, offset + 4 + metaLen));
    const bodyLen = view.getUint32(offset + 4 + metaLen, false);
    const payload = body.subarray(
      offset + 4 + metaLen + 4,
      offset + 4 + metaLen + 4 + bodyLen
    );
    frames.push({ meta, payload });
    offset += 4 + metaLen + 4 + bodyLen;
  }
  return frames;
}

/** The sequential-transition batch: completed(A), created(B), started(B). */
function transitionEvents(): BatchEventRequest[] {
  return [
    {
      event: {
        eventType: 'step_completed',
        specVersion: 6,
        correlationId: 'step_a',
        eventData: {
          stepName: 'step-a',
          workflowName: 'wf',
          result: utf8('"a-output"'),
        },
      },
      occurredAt: new Date('2026-08-14T00:00:01.000Z'),
    },
    {
      event: {
        eventType: 'step_created',
        specVersion: 6,
        correlationId: 'step_b',
        eventData: {
          stepName: 'step-b',
          workflowName: 'wf',
          input: utf8('"b-input"'),
        },
      },
      occurredAt: new Date('2026-08-14T00:00:02.000Z'),
    },
    {
      event: {
        eventType: 'step_started',
        specVersion: 6,
        correlationId: 'step_b',
        eventData: { stepName: 'step-b' },
      },
      occurredAt: new Date('2026-08-14T00:00:03.000Z'),
    },
  ];
}

const completedEvent = {
  eventId: slotEventId(8),
  runId: RUN_ID,
  eventType: 'step_completed',
  correlationId: 'step_a',
  createdAt: CREATED_AT,
  eventData: { stepName: 'step-a' },
};

const stepA = {
  runId: RUN_ID,
  stepId: 'step_a',
  stepName: 'step-a',
  status: 'completed',
  attempt: 1,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const createdEvent = {
  eventId: slotEventId(9),
  runId: RUN_ID,
  eventType: 'step_created',
  correlationId: 'step_b',
  createdAt: CREATED_AT,
  eventData: { stepName: 'step-b' },
};

const startedEvent = {
  eventId: slotEventId(10),
  runId: RUN_ID,
  eventType: 'step_started',
  correlationId: 'step_b',
  createdAt: CREATED_AT,
  eventData: { stepName: 'step-b' },
};

const stepB = {
  runId: RUN_ID,
  stepId: 'step_b',
  stepName: 'step-b',
  status: 'running',
  attempt: 1,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  startedAt: CREATED_AT,
};

const fullSuccessBody = () =>
  encode({
    results: [
      { status: 200, event: completedEvent, step: stepA },
      { status: 200, event: createdEvent, step: { ...stepB } },
      { status: 200, event: startedEvent, step: { ...stepB } },
    ],
  });

describe('createWorkflowRunEventBatch', () => {
  it('encodes one single-POST frame per event, in order, with no fence fields', async () => {
    const agent = mockAgent();
    let requestBody: Uint8Array | undefined;
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v4/runs/${RUN_ID}/events/batch`,
        method: 'POST',
        body: (raw) => {
          requestBody = new Uint8Array(Buffer.from(raw, 'binary'));
          return true;
        },
      })
      .reply(200, fullSuccessBody(), {
        headers: { 'content-type': 'application/cbor' },
      });

    const result = await createWorkflowRunEventBatch(
      RUN_ID,
      transitionEvents(),
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.results).toHaveLength(3);
    expect(requestBody).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const frames = decodeBatchFrames(requestBody!);
    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.meta.eventType)).toEqual([
      'step_completed',
      'step_created',
      'step_started',
    ]);
    expect(frames.map((frame) => frame.meta.correlationId)).toEqual([
      'step_a',
      'step_b',
      'step_b',
    ]);
    // Payload bytes ride the frame body; step_started has none.
    expect(new TextDecoder().decode(frames[0].payload)).toBe('"a-output"');
    expect(new TextDecoder().decode(frames[1].payload)).toBe('"b-input"');
    expect(frames[2].payload.byteLength).toBe(0);
    // Each frame carries its own client event time (the source of the
    // durable createdAt under slot identity).
    for (const frame of frames) {
      expect(frame.meta.occurredAt).toBeInstanceOf(Date);
    }
    // The retired fence design must never reappear on the wire.
    for (const frame of frames) {
      expect(frame.meta).not.toHaveProperty('expectedRunVersion');
      expect(frame.meta).not.toHaveProperty('batchId');
      expect(frame.meta).not.toHaveProperty('logicalCreatedAt');
    }
    agent.assertNoPendingInterceptors();
  });

  it('maps per-event outcomes: successes typed, failures passed through', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v4/runs/${RUN_ID}/events/batch`,
        method: 'POST',
      })
      .reply(
        200,
        encode({
          results: [
            {
              status: 409,
              error: 'conflict',
              message: 'step step_a already completed',
            },
            { status: 200, event: createdEvent, step: { ...stepB } },
            { status: 200, event: startedEvent, step: { ...stepB } },
          ],
        }),
        { headers: { 'content-type': 'application/cbor' } }
      );

    const { results } = await createWorkflowRunEventBatch(
      RUN_ID,
      transitionEvents(),
      undefined,
      { token: 'test-token', dispatcher: agent }
    );

    expect(results[0]).toEqual({
      status: 409,
      error: 'conflict',
      message: 'step step_a already completed',
    });
    expect(results[1].status).toBe(200);
    expect(results[1].event?.eventId).toBe(slotEventId(9));
    expect(results[2].status).toBe(200);
    expect(results[2].step?.status).toBe('running');
    agent.assertNoPendingInterceptors();
  });

  it('fails loudly when results length does not match the submitted frames', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v4/runs/${RUN_ID}/events/batch`,
        method: 'POST',
      })
      .reply(
        200,
        encode({
          results: [{ status: 200, event: completedEvent, step: stepA }],
        }),
        { headers: { 'content-type': 'application/cbor' } }
      );

    await expect(
      createWorkflowRunEventBatch(RUN_ID, transitionEvents(), undefined, {
        token: 'test-token',
        dispatcher: agent,
      })
    ).rejects.toMatchObject({
      name: 'WorkflowWorldError',
      code: 'SCHEMA_VALIDATION',
    });
  });

  it('fails loudly on an invalid success-item body, naming the index', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v4/runs/${RUN_ID}/events/batch`,
        method: 'POST',
      })
      .reply(
        200,
        encode({
          results: [
            { status: 200, event: completedEvent, step: stepA },
            { status: 200 }, // missing event — protocol violation
            { status: 200, event: startedEvent, step: { ...stepB } },
          ],
        }),
        { headers: { 'content-type': 'application/cbor' } }
      );

    await expect(
      createWorkflowRunEventBatch(RUN_ID, transitionEvents(), undefined, {
        token: 'test-token',
        dispatcher: agent,
      })
    ).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION',
      message: expect.stringContaining('index 1'),
    });
  });

  it('maps a request-level 400 to a typed WorkflowWorldError', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v4/runs/${RUN_ID}/events/batch`,
        method: 'POST',
      })
      .reply(
        400,
        JSON.stringify({
          success: false,
          error: 'invalid-event-batch',
          message: 'boom',
        }),
        { headers: { 'content-type': 'application/json' } }
      );

    await expect(
      createWorkflowRunEventBatch(RUN_ID, transitionEvents(), undefined, {
        token: 'test-token',
        dispatcher: agent,
      })
    ).rejects.toMatchObject({ name: 'WorkflowWorldError', status: 400 });
  });

  it('retries a transient 5xx in-process (the batch POST is idempotent-on-retry)', async () => {
    const agent = mockAgent();
    const pool = agent.get(ORIGIN);
    pool
      .intercept({
        path: `/api/v4/runs/${RUN_ID}/events/batch`,
        method: 'POST',
      })
      .reply(503, JSON.stringify({ message: 'unavailable' }), {
        headers: { 'content-type': 'application/json' },
      });
    pool
      .intercept({
        path: `/api/v4/runs/${RUN_ID}/events/batch`,
        method: 'POST',
      })
      .reply(200, fullSuccessBody(), {
        headers: { 'content-type': 'application/cbor' },
      });

    const { results } = await createWorkflowRunEventBatch(
      RUN_ID,
      transitionEvents(),
      undefined,
      { token: 'test-token', dispatcher: agent }
    );
    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    agent.assertNoPendingInterceptors();
  });

  it('rejects an empty batch without touching the network', async () => {
    await expect(
      createWorkflowRunEventBatch(RUN_ID, [], undefined, {
        token: 'test-token',
        dispatcher: mockAgent(),
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});
