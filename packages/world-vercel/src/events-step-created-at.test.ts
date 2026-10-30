/**
 * `stepCreatedAt` on the wire: a background step's first-attempt
 * `step_started` carries its step's creation time as a top-level key of the
 * frame meta, for a step start latency metric the backend reports. It is
 * request telemetry, so it never rides in the frame body (the event's
 * payload) and is left off every write the backend does not read it on.
 *
 * Asserted on the frames each transport actually sends: the single POST and
 * the batch route over HTTP, and the `event` and `event_batch` frames over
 * the run's socket.
 */

import { Buffer } from 'node:buffer';
import type { AnyEventRequest, BatchEventRequest } from '@workflow/world';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflowRunEvent,
  createWorkflowRunEventBatch,
} from './events.js';
import { decodeFrame } from './frames.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
const RUN_ID = 'wrun_1';
const STEP_CREATED_AT = Date.parse('2026-10-27T00:00:00.000Z');

const requestMock =
  vi.fn<(build: (reqId: number) => Uint8Array) => Promise<never>>();

vi.mock('./ws-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ws-transport.js')>();
  return {
    ...actual,
    // A socket only in the `ws` cases; the `http` cases resolve none and
    // send over HTTP.
    resolveWsTransport: () =>
      process.env.WORKFLOW_EVENTS_TRANSPORT === 'ws'
        ? {
            transport: { request: requestMock },
            wsUrl: `wss://vercel-workflow.com/api/websockets/v1/runs/${RUN_ID}`,
          }
        : undefined,
  };
});

type Frame = { meta: Record<string, unknown>; body: Uint8Array };

/** Splits concatenated v4 frames (a batch body). */
function splitFrames(bytes: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const metaLen = view.getUint32(offset, false);
    const bodyLen = view.getUint32(offset + 4 + metaLen, false);
    const end = offset + 4 + metaLen + 4 + bodyLen;
    const frame = decodeFrame(bytes.subarray(offset, end));
    frames.push({
      meta: frame.meta as Record<string, unknown>,
      body: frame.body,
    });
    offset = end;
  }
  return frames;
}

/**
 * Sends a write over `transport` and returns the event frames it put on the
 * wire. The transport answers with a failure: only the request matters here.
 */
async function sentFrames(
  transport: 'http' | 'ws',
  send: (config: { token: string; dispatcher?: MockAgent }) => Promise<unknown>,
  path: string
): Promise<Frame[]> {
  if (transport === 'ws') {
    process.env.WORKFLOW_EVENTS_TRANSPORT = 'ws';
    requestMock.mockRejectedValue(new Error('socket closed'));
    await send({ token: 'test-token' }).catch(() => {});
    expect(requestMock).toHaveBeenCalled();
    const frame = decodeFrame(requestMock.mock.calls[0][0](1));
    if (frame.meta.type === 'event_batch') {
      return splitFrames(frame.body);
    }
    expect(frame.meta.type).toBe('event');
    return [
      { meta: frame.meta.event as Record<string, unknown>, body: frame.body },
    ];
  }
  const agent = new MockAgent();
  agent.disableNetConnect();
  const bodies: Uint8Array[] = [];
  agent
    .get(ORIGIN)
    .intercept({
      path: `/api/v5/runs/${RUN_ID}/events/${path}`,
      method: 'POST',
      body: (raw) => {
        bodies.push(new Uint8Array(Buffer.from(raw, 'binary')));
        return true;
      },
    })
    .reply(400, 'refused')
    .persist();
  await send({ token: 'test-token', dispatcher: agent }).catch(() => {});
  expect(bodies.length).toBeGreaterThan(0);
  return splitFrames(bodies[0]);
}

const bareStart = (attempt: number): AnyEventRequest =>
  ({
    eventType: 'step_started',
    specVersion: 9,
    correlationId: 'step_1',
    eventData: { stepName: 'step', attempt },
  }) as AnyEventRequest;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.WORKFLOW_EVENTS_TRANSPORT;
});

describe.each(['http', 'ws'] as const)('stepCreatedAt over %s', (transport) => {
  const single = (event: AnyEventRequest, stepCreatedAt = STEP_CREATED_AT) =>
    sentFrames(
      transport,
      (config) =>
        createWorkflowRunEvent(
          RUN_ID,
          event,
          { inBand: false, stepCreatedAt },
          config
        ),
      event.eventType
    );

  it("puts a first-attempt background start's creation time in the frame meta", async () => {
    const [frame] = await single(bareStart(1));
    expect(frame.meta.eventType).toBe('step_started');
    expect(frame.meta.attempt).toBe(1);
    expect(frame.meta.stepCreatedAt).toBe(STEP_CREATED_AT);
    // Meta, not event data: the frame body carries nothing for it.
    expect(frame.meta).not.toHaveProperty('eventData');
    expect(frame.body.byteLength).toBe(0);
  });

  it('leaves it off a retry attempt', async () => {
    const [frame] = await single(bareStart(2));
    expect(frame.meta.attempt).toBe(2);
    expect(frame.meta).not.toHaveProperty('stepCreatedAt');
  });

  it('leaves it off an inline, creation-bearing start', async () => {
    const [frame] = await single({
      eventType: 'step_started',
      specVersion: 9,
      correlationId: 'step_1',
      eventData: {
        stepName: 'step',
        attempt: 1,
        input: new Uint8Array([1, 2, 3]),
        inline: true,
      },
    } as AnyEventRequest);
    expect(frame.meta).not.toHaveProperty('stepCreatedAt');
  });

  it('leaves it off other event types and a non-finite value', async () => {
    const [completed] = await single({
      eventType: 'step_completed',
      specVersion: 9,
      correlationId: 'step_1',
      eventData: { stepName: 'step', result: new Uint8Array([1]) },
    } as AnyEventRequest);
    expect(completed.meta).not.toHaveProperty('stepCreatedAt');
    vi.clearAllMocks();
    const [nan] = await single(bareStart(1), Number.NaN);
    expect(nan.meta).not.toHaveProperty('stepCreatedAt');
  });

  it('puts it on the batched first-attempt start only', async () => {
    const events: BatchEventRequest[] = [
      { event: bareStart(1), stepCreatedAt: STEP_CREATED_AT },
      {
        event: { ...bareStart(2), correlationId: 'step_2' } as AnyEventRequest,
        stepCreatedAt: STEP_CREATED_AT,
      },
      {
        event: { ...bareStart(1), correlationId: 'step_3' } as AnyEventRequest,
      },
    ];
    const frames = await sentFrames(
      transport,
      (config) =>
        createWorkflowRunEventBatch(RUN_ID, events, { inBand: false }, config),
      'batch'
    );
    expect(frames).toHaveLength(3);
    expect(frames[0].meta.stepCreatedAt).toBe(STEP_CREATED_AT);
    expect(frames[1].meta).not.toHaveProperty('stepCreatedAt');
    expect(frames[2].meta).not.toHaveProperty('stepCreatedAt');
  });
});
