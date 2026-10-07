import { Buffer } from 'node:buffer';
import { type Event, slotToEventId } from '@workflow/world';
import { decode } from 'cbor-x';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHookReceivedPreloadEventV4,
  createWorkflowRunStartedEventV4,
} from './events-v4.js';
import { encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import {
  classifyPreloadClaimResponse,
  PRELOAD_BASE_HEADER,
  PRELOAD_CLAIM_HEADER,
  PRELOAD_CLAIM_REPROBE_MS,
  type PreloadClaimWire,
  preloadClaimFor,
  preloadClaimKnownUnsupported,
  resetPreloadClaimSupportForTests,
} from './preload-prefix.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

vi.mock('./get-deadline.js', () => ({
  getDeadline: vi.fn(async () => undefined),
}));

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
const BASE_URL = `${ORIGIN}/api`;
const runId = 'wrun_prefix';
const CREATED_AT = new Date('2026-10-01T00:00:00.000Z');
const input = new TextEncoder().encode('"input"');

/** The durable log: run_created, run_started, then step_created events. */
function durable(length: number): Event[] {
  return Array.from({ length }, (_, index) => {
    const slot = index + 1;
    const eventType =
      slot === 1 ? 'run_created' : slot === 2 ? 'run_started' : 'step_created';
    return {
      runId,
      eventId: slotToEventId(slot),
      eventType,
      specVersion: 8,
      createdAt: new Date(+CREATED_AT + slot),
      ...(slot > 2 ? { correlationId: `step_${slot}` } : {}),
      eventData:
        slot === 1
          ? { deploymentId: 'dpl_1', workflowName: 'workflow', input }
          : slot > 2
            ? { stepName: 'step' }
            : undefined,
    } as Event;
  });
}

/** One event as the server frames it (payload in the body for run_created). */
function eventFrame(event: Event): Uint8Array {
  const { eventData, ...meta } = event as Event & { eventData?: unknown };
  if (event.eventType === 'run_created') {
    return encodeFrame(
      {
        ...meta,
        eventData: { ...(eventData as object), input: new Uint8Array() },
      },
      input
    );
  }
  return encodeFrame(
    eventData === undefined ? meta : { ...meta, eventData },
    new Uint8Array()
  );
}

function streamBody(events: Event[], next: string | null): Buffer {
  return Buffer.concat([
    ...events.map(eventFrame),
    encodeFrame(
      { _end: 1, ...(next ? { next } : {}), hasMore: false },
      new Uint8Array()
    ),
  ]);
}

/** Frame meta of a POST body: [u32 metaLen][cbor meta][u32 bodyLen][body]. */
function postMeta(body: unknown): Record<string, unknown> {
  const bytes =
    typeof body === 'string'
      ? Buffer.from(body, 'latin1')
      : Buffer.from(body as Uint8Array);
  const metaLen = bytes.readUInt32BE(0);
  return decode(bytes.subarray(4, 4 + metaLen)) as Record<string, unknown>;
}

const streamHeaders = (extra: Record<string, string> = {}) => ({
  'content-type': V4_FRAME_CONTENT_TYPE,
  'x-wf-event-id': slotToEventId(2),
  'x-wf-run-id': runId,
  'x-wf-created-at': CREATED_AT.toISOString(),
  'x-wf-max-events': '10000',
  ...extra,
});

const ids = (events: readonly Event[]) => events.map((e) => e.eventId);

describe('preloadClaimFor', () => {
  it('claims exactly the slots it was handed, anchored on the last', () => {
    const prefix = durable(5);
    expect(preloadClaimFor({ events: prefix })).toEqual({
      slot: 5,
      eventType: 'step_created',
      correlationId: 'step_5',
      createdAt: +CREATED_AT + 5,
      specVersion: 8,
      runStartedSlot: 2,
    });
  });

  it('sends nothing for a prefix it cannot vouch for', () => {
    const log = durable(5);
    expect(preloadClaimFor({ events: log.slice(0, 1) })).toBeUndefined();
    expect(preloadClaimFor({ events: log.slice(1) })).toBeUndefined();
    expect(
      preloadClaimFor({ events: [log[0], log[1], log[3]] })
    ).toBeUndefined();
    expect(
      preloadClaimFor({ events: [log[0], log[2], log[3]] })
    ).toBeUndefined();
    expect(
      preloadClaimFor({
        events: [{ ...log[0], specVersion: 6 } as Event, ...log.slice(1)],
      })
    ).toBeUndefined();
    expect(
      preloadClaimFor({
        events: [
          ...log.slice(0, 2),
          { ...log[2], eventId: 'evnt_01K00000000000000000000000' } as Event,
        ],
      })
    ).toBeUndefined();
  });
});

describe('classifyPreloadClaimResponse', () => {
  const claim = preloadClaimFor({ events: durable(4) }) as PreloadClaimWire;
  it.each([
    [
      { [PRELOAD_BASE_HEADER]: '4', [PRELOAD_CLAIM_HEADER]: 'honored' },
      'honored',
    ],
    [{ [PRELOAD_BASE_HEADER]: '3' }, 'mismatch'],
    [{ [PRELOAD_CLAIM_HEADER]: 'refused:version' }, 'refused'],
    [{}, 'unsupported'],
  ])('%o is %s', (headers, expected) => {
    expect(
      classifyPreloadClaimResponse(
        new Headers(headers as Record<string, string>),
        claim
      )
    ).toBe(expected);
  });
});

describe('tail-only preload in world-vercel', () => {
  let agent: MockAgent;
  const config = () => ({ token: 'test-token', dispatcher: agent });

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    resetPreloadClaimSupportForTests();
  });

  afterEach(() => {
    agent.assertNoPendingInterceptors();
    resetPreloadClaimSupportForTests();
    vi.useRealTimers();
  });

  function interceptRunStarted(
    reply: (meta: Record<string, unknown>) => {
      body: Buffer;
      headers: Record<string, string>;
    },
    eventType = 'run_started'
  ) {
    const metas: Record<string, unknown>[] = [];
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v4/runs/${runId}/events/${eventType}`,
        method: 'POST',
      })
      .reply((options) => {
        const meta = postMeta(options.body);
        metas.push(meta);
        const { body, headers } = reply(meta);
        return { statusCode: 200, data: body, responseOptions: { headers } };
      });
    return metas;
  }

  it('composes an honored tail onto the prefix: the full log, observed in order', async () => {
    const log = durable(7);
    const prefix = log.slice(0, 4);
    const metas = interceptRunStarted(() => ({
      body: streamBody(log.slice(4), `eid:${log[6].eventId}`),
      headers: streamHeaders({
        [PRELOAD_BASE_HEADER]: '4',
        [PRELOAD_CLAIM_HEADER]: 'honored',
      }),
    }));
    const observer = vi.fn();
    const result = await createWorkflowRunStartedEventV4(
      { runId, specVersion: 8 },
      config(),
      observer,
      { events: prefix }
    );
    expect(metas[0].preloadClaim).toMatchObject({
      slot: 4,
      eventType: 'step_created',
      correlationId: 'step_4',
      runStartedSlot: 2,
      specVersion: 8,
    });
    expect(result.preloadBase).toBe(4);
    expect(ids(result.events)).toEqual(ids(log));
    expect(result.events.slice(0, 4)).toEqual(prefix);
    expect(result.cursor).toBe(`eid:${log[6].eventId}`);
    expect(result.hasMore).toBe(false);
    expect(observer.mock.calls.map(([e]) => e.eventId)).toEqual(ids(log));
  });

  it('accepts an empty tail that ends at the claimed slot', async () => {
    const log = durable(4);
    interceptRunStarted(() => ({
      body: streamBody([], `eid:${log[3].eventId}`),
      headers: streamHeaders({ [PRELOAD_BASE_HEADER]: '4' }),
    }));
    const result = await createWorkflowRunStartedEventV4(
      { runId, specVersion: 8 },
      config(),
      undefined,
      { events: log }
    );
    expect(ids(result.events)).toEqual(ids(log));
    expect(result.cursor).toBe(`eid:${log[3].eventId}`);
    expect(result.preloadBase).toBe(4);
  });

  it('reads a refused claim as the full log', async () => {
    const log = durable(5);
    interceptRunStarted(() => ({
      body: streamBody(log, `eid:${log[4].eventId}`),
      headers: streamHeaders({ [PRELOAD_CLAIM_HEADER]: 'refused:version' }),
    }));
    const result = await createWorkflowRunStartedEventV4(
      { runId, specVersion: 8 },
      config(),
      undefined,
      { events: log.slice(0, 3) }
    );
    expect(result.preloadBase).toBeUndefined();
    expect(ids(result.events)).toEqual(ids(log));
    expect(preloadClaimKnownUnsupported(BASE_URL)).toBe(false);
  });

  it('remembers a backend that predates claims, then probes it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const log = durable(5);
    const metas = interceptRunStarted(() => ({
      body: streamBody(log, `eid:${log[4].eventId}`),
      headers: streamHeaders(),
    }));
    const first = await createWorkflowRunStartedEventV4(
      { runId, specVersion: 8 },
      config(),
      undefined,
      { events: log.slice(0, 3) }
    );
    expect(ids(first.events)).toEqual(ids(log));
    expect(metas[0].preloadClaim).toBeDefined();
    expect(preloadClaimKnownUnsupported(BASE_URL)).toBe(true);

    const secondMetas = interceptRunStarted(() => ({
      body: streamBody(log, `eid:${log[4].eventId}`),
      headers: streamHeaders(),
    }));
    await createWorkflowRunStartedEventV4(
      { runId, specVersion: 8 },
      config(),
      undefined,
      { events: log.slice(0, 3) }
    );
    // Inside the re-probe window no claim is built.
    expect(secondMetas[0].preloadClaim).toBeUndefined();

    vi.setSystemTime(Date.now() + PRELOAD_CLAIM_REPROBE_MS + 1);
    expect(preloadClaimKnownUnsupported(BASE_URL)).toBe(false);
  });

  it('reloads in full when the base header names another slot', async () => {
    const log = durable(6);
    const metas = interceptRunStarted(() => ({
      body: streamBody(log.slice(3), `eid:${log[5].eventId}`),
      headers: streamHeaders({ [PRELOAD_BASE_HEADER]: '3' }),
    }));
    const fullMetas = interceptRunStarted(() => ({
      body: streamBody(log, `eid:${log[5].eventId}`),
      headers: streamHeaders(),
    }));
    const result = await createWorkflowRunStartedEventV4(
      { runId, specVersion: 8 },
      config(),
      undefined,
      { events: log.slice(0, 4) }
    );
    expect(metas[0].preloadClaim).toBeDefined();
    expect(fullMetas[0].preloadClaim).toBeUndefined();
    expect(result.preloadBase).toBeUndefined();
    expect(ids(result.events)).toEqual(ids(log));
  });

  it.each([
    [
      'a tail that skips slot N + 1',
      (log: Event[]) => streamBody(log.slice(5), `eid:${log[6].eventId}`),
    ],
    [
      'a tail that repeats slot N',
      (log: Event[]) => streamBody(log.slice(3), `eid:${log[6].eventId}`),
    ],
    [
      'an empty tail ending elsewhere',
      (log: Event[]) => streamBody([], `eid:${log[2].eventId}`),
    ],
    ['an empty tail with no cursor', () => streamBody([], null)],
  ])('reloads in full on %s', async (_label, tailBody) => {
    const log = durable(7);
    interceptRunStarted(() => ({
      body: tailBody(log),
      headers: streamHeaders({ [PRELOAD_BASE_HEADER]: '4' }),
    }));
    const fullMetas = interceptRunStarted(() => ({
      body: streamBody(log, `eid:${log[6].eventId}`),
      headers: streamHeaders(),
    }));
    const result = await createWorkflowRunStartedEventV4(
      { runId, specVersion: 8 },
      config(),
      undefined,
      { events: log.slice(0, 4) }
    );
    expect(fullMetas[0].preloadClaim).toBeUndefined();
    expect(result.preloadBase).toBeUndefined();
    expect(ids(result.events)).toEqual(ids(log));
  });

  it('composes an honored hook_received preload the same way', async () => {
    const log = durable(5);
    const hookReceived = {
      runId,
      eventId: slotToEventId(6),
      eventType: 'hook_received',
      specVersion: 8,
      createdAt: new Date(+CREATED_AT + 6),
      correlationId: 'hook_1',
      resumeId: 'resume-1',
      eventData: { token: 'tok' },
    } as unknown as Event;
    const metas = interceptRunStarted(
      () => ({
        body: streamBody([hookReceived], `eid:${hookReceived.eventId}`),
        headers: streamHeaders({
          'x-wf-event-id': hookReceived.eventId,
          [PRELOAD_BASE_HEADER]: '5',
          [PRELOAD_CLAIM_HEADER]: 'honored',
        }),
      }),
      'hook_received'
    );
    const result = await createHookReceivedPreloadEventV4(
      {
        runId,
        specVersion: 8,
        correlationId: 'hook_1',
        resumeId: 'resume-1',
        resumePayloadDigest: 'a'.repeat(64),
      },
      config(),
      undefined,
      { events: log }
    );
    expect(metas[0].preloadClaim).toMatchObject({ slot: 5 });
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    expect(result.preloadBase).toBe(5);
    expect(result.canonicalEventId).toBe(hookReceived.eventId);
    expect(ids(result.events)).toEqual([...ids(log), hookReceived.eventId]);
  });

  it('sends no claim when nothing is offered', async () => {
    const log = durable(3);
    const metas = interceptRunStarted(() => ({
      body: streamBody(log, `eid:${log[2].eventId}`),
      headers: streamHeaders(),
    }));
    await createWorkflowRunStartedEventV4({ runId, specVersion: 8 }, config());
    expect(metas[0].preloadClaim).toBeUndefined();
    // A claim-less request teaches nothing about support.
    expect(preloadClaimKnownUnsupported(BASE_URL)).toBe(false);
  });
});
