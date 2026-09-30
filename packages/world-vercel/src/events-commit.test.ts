import { Buffer } from 'node:buffer';
import { AmbiguousCommitError } from '@workflow/errors';
import type { BatchEventRequest } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitWorkflowRunEvents } from './events.js';
import {
  FENCED_COMMIT_CAPABILITY_HEADER,
  FENCED_COMMIT_OUTCOME_HEADER,
  FENCED_COMMIT_UNSUPPORTED_MEMO_MS,
  resetFencedCommitSupportForTests,
} from './events-v4.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

/**
 * POST /api/v4/runs/:runId/events/batch/commit — the client wire half of the
 * fenced piggyback commit (workflow-server `docs/fenced-commit.md` §3.1).
 *
 * What these tests pin down:
 *  - the body is a `{ after, own }` preamble frame with an empty body, then the
 *    events' single-POST frames back-to-back, byte-identical to the batch's;
 *  - the outcome table: 200 → committed; outcome `rejected` → definite;
 *    outcome `ambiguous`, an un-typed 5xx, a transport failure, or an unusable
 *    200 → `AmbiguousCommitError`; a 404/405 WITHOUT the capability header →
 *    `unsupported`, remembered for ten minutes; the same status WITH it (the
 *    route's own run-not-found) is an ordinary rejection and never remembered;
 *  - exactly one request, on every outcome: the commit carries a
 *    `step_started`, so nothing retries it in-process.
 */

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
const RUN_ID = 'wrun_commit';
const PATH = `/api/v4/runs/${RUN_ID}/events/batch/commit`;
const T1 = new Date('2026-09-28T00:00:01.000Z');
const T2 = new Date('2026-09-28T00:00:02.000Z');

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const slotEventId = (slot: number): string =>
  `evnt_${String(slot).padStart(26, '0')}`;

function mockAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

function decodeFrames(
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

function stepPair(): BatchEventRequest[] {
  return [
    {
      event: {
        eventType: 'step_completed',
        specVersion: 7,
        correlationId: 'step_a',
        eventData: {
          stepName: 'step-a',
          workflowName: 'wf',
          result: utf8('"a-output"'),
        },
      },
      occurredAt: T1,
    },
    {
      event: {
        eventType: 'step_created',
        specVersion: 7,
        correlationId: 'step_b',
        eventData: {
          stepName: 'step-b',
          workflowName: 'wf',
          input: utf8('"b-input"'),
        },
      },
      occurredAt: T2,
    },
    {
      event: {
        eventType: 'step_started',
        specVersion: 7,
        correlationId: 'step_b',
        eventData: { stepName: 'step-b', ownerMessageId: 'msg_1' },
      },
      occurredAt: T2,
      computeInstanceId: 'ci_1',
    },
  ];
}

const stepB = {
  runId: RUN_ID,
  stepId: 'step_b',
  stepName: 'step-b',
  status: 'running',
  attempt: 1,
  createdAt: T2.toISOString(),
  updatedAt: T2.toISOString(),
  startedAt: T2.toISOString(),
};

const committedBody = () =>
  encode({
    status: 'committed',
    results: [
      {
        status: 200,
        event: {
          eventId: slotEventId(6),
          runId: RUN_ID,
          eventType: 'step_completed',
          correlationId: 'step_a',
          createdAt: T1.toISOString(),
          eventData: { stepName: 'step-a' },
        },
        step: { ...stepB, stepId: 'step_a', status: 'completed' },
      },
      {
        status: 200,
        event: {
          eventId: slotEventId(7),
          runId: RUN_ID,
          eventType: 'step_created',
          correlationId: 'step_b',
          createdAt: T2.toISOString(),
          eventData: { stepName: 'step-b' },
        },
        step: stepB,
      },
      {
        status: 200,
        event: {
          eventId: slotEventId(8),
          runId: RUN_ID,
          eventType: 'step_started',
          correlationId: 'step_b',
          createdAt: T2.toISOString(),
          eventData: { stepName: 'step-b', ownerMessageId: 'msg_1' },
        },
        step: stepB,
      },
    ],
    denseThrough: 8,
    cursor: 'cursor_after_8',
  });

const config = (agent: MockAgent) => ({
  token: 'test-token',
  dispatcher: agent,
});

beforeEach(() => {
  resetFencedCommitSupportForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('commitWorkflowRunEvents (HTTP)', () => {
  it('sends a { after, own } preamble frame, then the batch frames', async () => {
    const agent = mockAgent();
    let requestBody: Uint8Array | undefined;
    agent
      .get(ORIGIN)
      .intercept({
        path: PATH,
        method: 'POST',
        body: (raw) => {
          requestBody = new Uint8Array(Buffer.from(raw, 'binary'));
          return true;
        },
      })
      .reply(200, committedBody(), {
        headers: {
          'content-type': 'application/cbor',
          [FENCED_COMMIT_CAPABILITY_HEADER]: '1',
          [FENCED_COMMIT_OUTCOME_HEADER]: 'committed',
        },
      });

    const result = await commitWorkflowRunEvents(
      RUN_ID,
      { after: 3, own: [slotEventId(4), slotEventId(5)], events: stepPair() },
      undefined,
      config(agent)
    );

    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('unreachable');
    expect(result.denseThrough).toBe(8);
    expect(result.cursor).toBe('cursor_after_8');
    expect(result.results.map((r) => r.event.eventId)).toEqual([
      slotEventId(6),
      slotEventId(7),
      slotEventId(8),
    ]);
    expect(result.results[0].event.createdAt).toEqual(T1);

    // biome-ignore lint/style/noNonNullAssertion: captured by the interceptor
    const frames = decodeFrames(requestBody!);
    expect(frames).toHaveLength(4);
    expect(frames[0].meta).toStrictEqual({
      after: 3,
      own: [slotEventId(4), slotEventId(5)],
    });
    expect(frames[0].payload.byteLength).toBe(0);
    expect(frames.slice(1).map((f) => f.meta.eventType)).toEqual([
      'step_completed',
      'step_created',
      'step_started',
    ]);
    // Each event carries exactly its occurredAt: the row's createdAt verbatim.
    expect(frames[1].meta.occurredAt).toEqual(T1);
    expect(frames[2].meta.occurredAt).toEqual(T2);
    expect(new TextDecoder().decode(frames[1].payload)).toBe('"a-output"');
    expect(new TextDecoder().decode(frames[2].payload)).toBe('"b-input"');
    // The started row is bare and ownership-stamped.
    expect(frames[3].payload.byteLength).toBe(0);
    expect(frames[3].meta.ownerMessageId).toBe('msg_1');
    expect(frames[3].meta.computeInstanceId).toBe('ci_1');
    agent.assertNoPendingInterceptors();
  });

  it('maps a typed rejection to a definite no-commit with its reason', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(
        409,
        JSON.stringify({
          error: 'fenced-commit-rejected',
          message: 'a foreign event sits in the gap',
          status: 'rejected',
          reason: 'fence',
          conflictSlot: 5,
        }),
        {
          headers: {
            'content-type': 'application/json',
            [FENCED_COMMIT_CAPABILITY_HEADER]: '1',
            [FENCED_COMMIT_OUTCOME_HEADER]: 'rejected',
          },
        }
      );

    const result = await commitWorkflowRunEvents(
      RUN_ID,
      { after: 3, own: [], events: stepPair() },
      undefined,
      config(agent)
    );
    expect(result).toEqual({
      status: 'rejected',
      reason: 'fence',
      httpStatus: 409,
      conflictSlot: 5,
    });
    agent.assertNoPendingInterceptors();
  });

  it.each([
    { status: 410, reason: 'http-410' },
    { status: 400, reason: 'http-400' },
    { status: 503, reason: 'http-503' },
  ])('treats an HTTP $status the route marks rejected as definite', async ({
    status,
    reason,
  }) => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(status, JSON.stringify({ error: 'x', message: 'x' }), {
        headers: {
          'content-type': 'application/json',
          [FENCED_COMMIT_CAPABILITY_HEADER]: '1',
          [FENCED_COMMIT_OUTCOME_HEADER]: 'rejected',
        },
      });
    const result = await commitWorkflowRunEvents(
      RUN_ID,
      { after: 3, own: [], events: stepPair() },
      undefined,
      config(agent)
    );
    expect(result).toEqual({ status: 'rejected', reason, httpStatus: status });
  });

  it('treats a middleware refusal (4xx, no outcome) as definite', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(429, JSON.stringify({ error: 'rate-limited', message: 'slow' }), {
        headers: {
          'content-type': 'application/json',
          [FENCED_COMMIT_CAPABILITY_HEADER]: '1',
          'retry-after': '1',
        },
      });
    const result = await commitWorkflowRunEvents(
      RUN_ID,
      { after: 3, own: [], events: stepPair() },
      undefined,
      config(agent)
    );
    expect(result).toEqual({
      status: 'rejected',
      reason: 'http-429',
      httpStatus: 429,
    });
    agent.assertNoPendingInterceptors();
  });

  it.each([
    {
      name: 'the route says ambiguous',
      status: 503,
      headers: {
        [FENCED_COMMIT_CAPABILITY_HEADER]: '1',
        [FENCED_COMMIT_OUTCOME_HEADER]: 'ambiguous',
      },
    },
    {
      name: 'an un-typed 5xx',
      status: 502,
      headers: {},
    },
    {
      name: 'a 500 from the route without an outcome',
      status: 500,
      headers: { [FENCED_COMMIT_CAPABILITY_HEADER]: '1' },
    },
  ])('throws AmbiguousCommitError when $name, and does not retry', async ({
    status,
    headers,
  }) => {
    const agent = mockAgent();
    // One interceptor: a retry would find none and fail the test.
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(status, JSON.stringify({ status: 'ambiguous' }), {
        headers: { 'content-type': 'application/json', ...headers },
      });
    await expect(
      commitWorkflowRunEvents(
        RUN_ID,
        { after: 3, own: [], events: stepPair() },
        undefined,
        config(agent)
      )
    ).rejects.toSatisfy(AmbiguousCommitError.is);
    agent.assertNoPendingInterceptors();
  });

  it('throws AmbiguousCommitError on a transport failure', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .replyWithError(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      );
    await expect(
      commitWorkflowRunEvents(
        RUN_ID,
        { after: 3, own: [], events: stepPair() },
        undefined,
        config(agent)
      )
    ).rejects.toSatisfy(AmbiguousCommitError.is);
  });

  it('throws AmbiguousCommitError when a 200 body is unusable', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, encode({ status: 'committed', results: [] }), {
        headers: {
          'content-type': 'application/cbor',
          [FENCED_COMMIT_CAPABILITY_HEADER]: '1',
          [FENCED_COMMIT_OUTCOME_HEADER]: 'committed',
        },
      });
    await expect(
      commitWorkflowRunEvents(
        RUN_ID,
        { after: 3, own: [], events: stepPair() },
        undefined,
        config(agent)
      )
    ).rejects.toSatisfy(AmbiguousCommitError.is);
  });

  it('remembers a 404 without the capability header as unsupported for ten minutes', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(404, JSON.stringify({ error: 'not-found', message: 'no route' }), {
        headers: { 'content-type': 'application/json' },
      });

    const first = await commitWorkflowRunEvents(
      RUN_ID,
      { after: 3, own: [], events: stepPair() },
      undefined,
      config(agent)
    );
    expect(first).toEqual({
      status: 'rejected',
      reason: 'unsupported',
      httpStatus: 404,
      unsupportedForMs: FENCED_COMMIT_UNSUPPORTED_MEMO_MS,
    });
    agent.assertNoPendingInterceptors();

    // Remembered: answered without a request (no interceptor is left).
    const second = await commitWorkflowRunEvents(
      RUN_ID,
      { after: 3, own: [], events: stepPair() },
      undefined,
      config(agent)
    );
    expect(second.status).toBe('rejected');
    if (second.status !== 'rejected') throw new Error('unreachable');
    expect(second.reason).toBe('unsupported');
    expect(second.unsupportedForMs).toBeGreaterThan(0);

    // Past the memo it probes again.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(
      now + FENCED_COMMIT_UNSUPPORTED_MEMO_MS + 1
    );
    agent
      .get(ORIGIN)
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, committedBody(), {
        headers: {
          'content-type': 'application/cbor',
          [FENCED_COMMIT_CAPABILITY_HEADER]: '1',
          [FENCED_COMMIT_OUTCOME_HEADER]: 'committed',
        },
      });
    const third = await commitWorkflowRunEvents(
      RUN_ID,
      { after: 3, own: [], events: stepPair() },
      undefined,
      config(agent)
    );
    vi.mocked(Date.now).mockRestore();
    expect(third.status).toBe('committed');
    agent.assertNoPendingInterceptors();
  });

  it('never remembers the route’s own 404 (run-not-found carries the capability header)', async () => {
    const agent = mockAgent();
    for (let i = 0; i < 2; i++) {
      agent
        .get(ORIGIN)
        .intercept({ path: PATH, method: 'POST' })
        .reply(404, JSON.stringify({ error: 'not-found', message: 'no run' }), {
          headers: {
            'content-type': 'application/json',
            [FENCED_COMMIT_CAPABILITY_HEADER]: '1',
            [FENCED_COMMIT_OUTCOME_HEADER]: 'rejected',
          },
        });
    }
    for (let i = 0; i < 2; i++) {
      const result = await commitWorkflowRunEvents(
        RUN_ID,
        { after: 3, own: [], events: stepPair() },
        undefined,
        config(agent)
      );
      expect(result).toEqual({
        status: 'rejected',
        reason: 'http-404',
        httpStatus: 404,
      });
    }
    // Both requests went out: nothing was memoized.
    agent.assertNoPendingInterceptors();
  });

  it('refuses an event without occurredAt before sending anything', async () => {
    const agent = mockAgent();
    const events = stepPair();
    delete events[0].occurredAt;
    await expect(
      commitWorkflowRunEvents(
        RUN_ID,
        { after: 3, own: [], events },
        undefined,
        config(agent)
      )
    ).rejects.toThrow(/occurredAt/);
  });
});
