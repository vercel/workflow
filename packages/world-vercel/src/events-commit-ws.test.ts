/**
 * The fenced piggyback commit over the WS events channel: the `commit` request
 * frame and how its `commit_ack` / `error` replies map onto the same outcome
 * table as the HTTP route (workflow-server `docs/ws-protocol.md`).
 *
 * Kept apart from `events-commit.test.ts` because `./ws-transport.js` is
 * mocked at module level here.
 */

import { AmbiguousCommitError } from '@workflow/errors';
import type { BatchEventRequest } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitWorkflowRunEvents } from './events.js';
import {
  FENCED_COMMIT_UNSUPPORTED_MEMO_MS,
  resetFencedCommitSupportForTests,
} from './events-v4.js';
import { type WsFrameReply, WsTransportError } from './ws-transport.js';

const WS_URL = 'wss://vercel-workflow.com/api/websockets/v1/runs/wrun_ws';
const RUN_ID = 'wrun_ws';
const T1 = new Date('2026-09-28T00:00:01.000Z');
const T2 = new Date('2026-09-28T00:00:02.000Z');

const sentFrames: Uint8Array[] = [];
const requestMock = vi.fn<() => Promise<WsFrameReply>>();
const resolveWsTransportMock = vi.fn<
  () => { transport: unknown; wsUrl: string } | null
>(() => ({
  transport: {
    request: async (build: (reqId: number) => Uint8Array) => {
      sentFrames.push(build(7));
      return requestMock();
    },
  },
  wsUrl: WS_URL,
}));

vi.mock('./ws-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ws-transport.js')>();
  return {
    ...actual,
    resolveWsTransport: () => resolveWsTransportMock(),
  };
});

const slotEventId = (slot: number): string =>
  `evnt_${String(slot).padStart(26, '0')}`;

function runEndPair(): BatchEventRequest[] {
  return [
    {
      event: {
        eventType: 'step_completed',
        specVersion: 7,
        correlationId: 'step_a',
        eventData: { stepName: 'a', result: new TextEncoder().encode('1') },
      },
      occurredAt: T1,
    },
    {
      event: {
        eventType: 'run_completed',
        specVersion: 7,
        eventData: { output: new TextEncoder().encode('2') },
      },
      occurredAt: T2,
    },
  ];
}

function decodeFrame(frame: Uint8Array): {
  meta: Record<string, unknown>;
  body: Uint8Array;
} {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const metaLen = view.getUint32(0, false);
  const meta = decode(frame.subarray(4, 4 + metaLen));
  const bodyLen = view.getUint32(4 + metaLen, false);
  return { meta, body: frame.subarray(8 + metaLen, 8 + metaLen + bodyLen) };
}

const runRow = {
  runId: RUN_ID,
  deploymentId: 'dpl',
  workflowName: 'wf',
  status: 'completed',
  specVersion: 7,
  input: new Uint8Array(),
  output: new Uint8Array(),
  createdAt: T1.toISOString(),
  updatedAt: T2.toISOString(),
  startedAt: T1.toISOString(),
  completedAt: T2.toISOString(),
};

const committedBody = () =>
  new Uint8Array(
    encode({
      status: 'committed',
      results: [
        {
          status: 200,
          event: {
            eventId: slotEventId(5),
            runId: RUN_ID,
            eventType: 'step_completed',
            correlationId: 'step_a',
            createdAt: T1.toISOString(),
            eventData: { stepName: 'a' },
          },
        },
        {
          status: 200,
          event: {
            eventId: slotEventId(6),
            runId: RUN_ID,
            eventType: 'run_completed',
            createdAt: T2.toISOString(),
            eventData: {},
          },
          run: runRow,
        },
      ],
      denseThrough: 6,
      cursor: 'cursor_6',
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  sentFrames.length = 0;
  resetFencedCommitSupportForTests();
  process.env.WORKFLOW_EVENTS_TRANSPORT = 'ws';
});

afterEach(() => {
  delete process.env.WORKFLOW_EVENTS_TRANSPORT;
  delete process.env.WORKFLOW_INTERNAL_EVENTS_TRANSPORT_STRICT;
});

const commit = () =>
  commitWorkflowRunEvents(
    RUN_ID,
    { after: 4, own: [], events: runEndPair() },
    undefined,
    { token: 'test-token' }
  );

describe('commitWorkflowRunEvents (WS)', () => {
  it('sends a commit frame whose body is the event frames, and reads commit_ack', async () => {
    requestMock.mockResolvedValueOnce({
      meta: {
        reqId: 7,
        type: 'commit_ack',
        status: 200,
        fencedCommit: '1',
        outcome: 'committed',
        denseThrough: '6',
      },
      body: committedBody(),
    });

    const result = await commit();
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('unreachable');
    expect(result.denseThrough).toBe(6);
    expect(result.results[1].run?.status).toBe('completed');

    expect(sentFrames).toHaveLength(1);
    const { meta, body } = decodeFrame(sentFrames[0]);
    expect(meta).toStrictEqual({
      reqId: 7,
      type: 'commit',
      commit: { after: 4, own: [] },
    });
    // The body is the event frames only: the server rebuilds the preamble.
    const first = decodeFrame(body);
    expect(first.meta.eventType).toBe('step_completed');
    expect(first.meta.occurredAt).toEqual(T1);
  });

  it('maps a rejected commit_ack to a definite no-commit', async () => {
    requestMock.mockResolvedValueOnce({
      meta: {
        reqId: 7,
        type: 'commit_ack',
        status: 409,
        fencedCommit: '1',
        outcome: 'rejected',
      },
      body: new Uint8Array(
        encode({ status: 'rejected', reason: 'run-state', error: 'x' })
      ),
    });
    expect(await commit()).toEqual({
      status: 'rejected',
      reason: 'run-state',
      httpStatus: 409,
    });
  });

  it('remembers an old server’s 400 "ws v1 frame" refusal as unsupported', async () => {
    requestMock.mockResolvedValueOnce({
      meta: { reqId: 7, type: 'error', status: 400 },
      body: new TextEncoder().encode(
        JSON.stringify({ message: 'ws v1 frame: Invalid input' })
      ),
    });
    expect(await commit()).toEqual({
      status: 'rejected',
      reason: 'unsupported',
      httpStatus: 400,
      unsupportedForMs: FENCED_COMMIT_UNSUPPORTED_MEMO_MS,
    });
    // Remembered: the next commit sends nothing.
    const second = await commit();
    expect(second.status).toBe('rejected');
    expect(sentFrames).toHaveLength(1);
  });

  it.each([
    {
      name: 'an error frame 500',
      reply: {
        meta: { reqId: 7, type: 'error', status: 500 },
        body: new TextEncoder().encode(JSON.stringify({ message: 'boom' })),
      },
    },
    {
      name: 'a commit_ack marked ambiguous',
      reply: {
        meta: {
          reqId: 7,
          type: 'commit_ack',
          status: 503,
          fencedCommit: '1',
          outcome: 'ambiguous',
        },
        body: new Uint8Array(encode({ status: 'ambiguous' })),
      },
    },
    {
      name: 'an unknown reply type',
      reply: {
        meta: { reqId: 7, type: 'event_ack', status: 200 },
        body: new Uint8Array(),
      },
    },
  ])('throws AmbiguousCommitError for $name', async ({ reply }) => {
    requestMock.mockResolvedValueOnce(reply as WsFrameReply);
    await expect(commit()).rejects.toSatisfy(AmbiguousCommitError.is);
  });

  it('throws AmbiguousCommitError when the socket fails mid-request', async () => {
    requestMock.mockRejectedValueOnce(new WsTransportError('closed'));
    await expect(commit()).rejects.toSatisfy(AmbiguousCommitError.is);
  });

  it('refuses to fall back to HTTP under the strict WS gate', async () => {
    process.env.WORKFLOW_INTERNAL_EVENTS_TRANSPORT_STRICT = '1';
    resolveWsTransportMock.mockReturnValueOnce(null);
    await expect(commit()).rejects.toThrow(/fell back to the HTTP/);
  });
});
