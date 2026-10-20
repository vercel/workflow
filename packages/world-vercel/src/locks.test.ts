import { LockUnsupportedError, WorkflowWorldError } from '@workflow/errors';
import type { AnyEventRequest } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkflowRunEvent,
  createWorkflowRunEventBatch,
  splitEventDataForV4,
} from './events.js';
import {
  createWorld,
  EXPERIMENTAL_LOCKS_ENV_VAR,
  EXPERIMENTAL_LOCKS_FIFO_ENV_VAR,
} from './index.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';

const lockCreated = {
  eventType: 'lock_created',
  correlationId: 'lock_01',
  specVersion: 8,
  eventData: { key: 'stripe:cus_1', concurrency: 5, leaseTtlMs: 60_000 },
} as AnyEventRequest;

/** The CBOR meta block of a posted v4 frame (as in events.test.ts). */
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

function mockAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

describe('lock events on the v4 wire', () => {
  it('routes the lock fields to the namespaced frame meta', () => {
    const { payload, meta } = splitEventDataForV4(lockCreated);
    expect(payload).toBeUndefined();
    expect(meta).toMatchObject({
      lockKey: 'stripe:cus_1',
      lockConcurrency: 5,
      lockLeaseTtlMs: 60_000,
    });
    expect(
      splitEventDataForV4({
        eventType: 'lock_released',
        correlationId: 'lock_01',
        specVersion: 8,
        eventData: { key: 'stripe:cus_1' },
      } as AnyEventRequest).meta
    ).toMatchObject({ lockKey: 'stripe:cus_1' });
  });

  it('carries a FIFO wake target as lockWake', () => {
    const wake = {
      queueName: '__wkf_workflow_w',
      deploymentId: 'dpl_1',
      specVersion: 8,
    };
    const { meta } = splitEventDataForV4({
      ...lockCreated,
      eventData: { ...(lockCreated as any).eventData, wake },
    } as AnyEventRequest);
    expect(meta.lockWake).toEqual(wake);
  });

  it('never reads `key` or `concurrency` off a non-lock event', () => {
    const { meta } = splitEventDataForV4({
      eventType: 'wait_created',
      correlationId: 'wait_01',
      specVersion: 8,
      eventData: { resumeAt: new Date(0), key: 'x', concurrency: 1 } as never,
    } as AnyEventRequest);
    expect(meta).not.toHaveProperty('lockKey');
    expect(meta).not.toHaveProperty('lockConcurrency');
  });

  it("returns the server's committed event and the scope's `lock`", async () => {
    const agent = mockAgent();
    let posted: Record<string, unknown> | undefined;
    const retryAt = new Date('2026-10-19T12:00:03.000Z');
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/lock_created',
        method: 'POST',
      })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          posted = decodePostedMeta(opts.body);
          return encode({
            event: {
              ...lockCreated,
              eventData: { ...lockCreated.eventData, retryAt },
              eventId: 'evnt_3',
              runId: 'wrun_1',
              createdAt: new Date('2026-10-19T12:00:00.000Z'),
            },
            lock: {
              key: 'stripe:cus_1',
              status: 'pending',
              retryAt,
              concurrency: 5,
            },
          });
        },
        {
          headers: {
            'content-type': 'application/cbor',
            'x-wf-event-id': 'evnt_3',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': '2026-10-19T12:00:00.000Z',
          },
        }
      );

    const result = await createWorkflowRunEvent('wrun_1', lockCreated, {}, {
      token: 't',
      dispatcher: agent,
    } as never);

    expect(posted).toMatchObject({
      lockKey: 'stripe:cus_1',
      lockConcurrency: 5,
      lockLeaseTtlMs: 60_000,
    });
    expect(result.event?.eventType).toBe('lock_created');
    expect(result.lock).toMatchObject({ status: 'pending', retryAt });
    agent.assertNoPendingInterceptors();
  });

  it('accepts the lock_acquired the server commits in place of a granted lock_created', async () => {
    const agent = mockAgent();
    const createdAt = new Date('2026-10-19T12:00:00.000Z');
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/lock_created',
        method: 'POST',
      })
      .reply(
        200,
        encode({
          event: {
            eventType: 'lock_acquired',
            correlationId: 'lock_01',
            specVersion: 8,
            eventData: {
              key: 'stripe:cus_1',
              concurrency: 5,
              effectiveConcurrency: 5,
              fencingToken: 7,
            },
            eventId: 'evnt_3',
            runId: 'wrun_1',
            createdAt,
          },
          lock: {
            key: 'stripe:cus_1',
            status: 'held',
            fencingToken: 7,
            concurrency: 5,
          },
        }),
        {
          headers: {
            'content-type': 'application/cbor',
            'x-wf-event-id': 'evnt_3',
            'x-wf-run-id': 'wrun_1',
            'x-wf-created-at': createdAt.toISOString(),
          },
        }
      );

    const result = await createWorkflowRunEvent('wrun_1', lockCreated, {}, {
      token: 't',
      dispatcher: agent,
    } as never);
    expect(result.event?.eventType).toBe('lock_acquired');
    expect(result.lock).toMatchObject({ status: 'held', fencingToken: 7 });
    agent.assertNoPendingInterceptors();
  });

  it('reads lockHandoffs off a release, and lock_failed off a refused acquisition', async () => {
    const agent = mockAgent();
    const grantedAt = new Date('2026-10-20T12:00:00.000Z');
    const headers = {
      'content-type': 'application/cbor',
      'x-wf-event-id': 'evnt_4',
      'x-wf-run-id': 'wrun_1',
      'x-wf-created-at': grantedAt.toISOString(),
    };
    const base = {
      correlationId: 'lock_01',
      specVersion: 8,
      eventId: 'evnt_4',
      runId: 'wrun_1',
      createdAt: grantedAt,
    };
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/lock_released',
        method: 'POST',
      })
      .reply(
        200,
        encode({
          event: {
            ...base,
            eventType: 'lock_released',
            eventData: { key: 'stripe:cus_1' },
          },
          lock: { key: 'stripe:cus_1', status: 'released' },
          lockHandoffs: [
            {
              key: 'stripe:cus_1',
              runId: 'wrun_2',
              correlationId: 'lock_02',
              grantedAt,
              wake: { queueName: '__wkf_workflow_w', deploymentId: 'dpl_2' },
            },
          ],
        }),
        { headers }
      );
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/lock_created',
        method: 'POST',
      })
      .reply(
        200,
        encode({
          event: {
            ...base,
            eventType: 'lock_failed',
            eventData: {
              key: 'stripe:cus_1',
              concurrency: 5,
              reason: 'waitlist_full',
              waitlistCap: 100_000,
            },
          },
          lock: {
            key: 'stripe:cus_1',
            status: 'failed',
            reason: 'waitlist_full',
          },
        }),
        { headers }
      );

    const released = await createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'lock_released',
        correlationId: 'lock_01',
        specVersion: 8,
        eventData: { key: 'stripe:cus_1' },
      } as AnyEventRequest,
      {},
      { token: 't', dispatcher: agent } as never
    );
    expect(released.lockHandoffs).toEqual([
      expect.objectContaining({ runId: 'wrun_2', grantedAt }),
    ]);
    const refused = await createWorkflowRunEvent('wrun_1', lockCreated, {}, {
      token: 't',
      dispatcher: agent,
    } as never);
    expect(refused.event?.eventType).toBe('lock_failed');
    expect(refused.lock).toMatchObject({ status: 'failed' });
    agent.assertNoPendingInterceptors();
  });

  it.each([
    ['lock-unsupported', 'Concurrency locks are off for this project'],
    [undefined, "meta.eventType: unknown event type 'lock_created'"],
  ])('maps a 400 (%s) to LockUnsupportedError', async (code, message) => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v4/runs/wrun_1/events/lock_created',
        method: 'POST',
      })
      .reply(400, encode({ message, ...(code ? { code } : {}) }), {
        headers: { 'content-type': 'application/cbor' },
      });

    const error = await createWorkflowRunEvent('wrun_1', lockCreated, {}, {
      token: 't',
      dispatcher: agent,
    } as never).catch((err: unknown) => err);
    expect(LockUnsupportedError.is(error)).toBe(true);
    expect((error as LockUnsupportedError).key).toBe('stripe:cus_1');
  });

  it('refuses lock_waiter_queued and batched lock events before the wire', async () => {
    const waiter = createWorkflowRunEvent(
      'wrun_1',
      {
        eventType: 'lock_waiter_queued',
        correlationId: 'lock_01',
        specVersion: 8,
        eventData: { key: 'k', runId: 'wrun_2', correlationId: 'lock_02' },
      } as AnyEventRequest,
      {},
      { token: 't', dispatcher: mockAgent() } as never
    );
    await expect(waiter).rejects.toBeInstanceOf(WorkflowWorldError);
    await expect(
      createWorkflowRunEventBatch('wrun_1', [{ event: lockCreated }], {}, {
        token: 't',
        dispatcher: mockAgent(),
      } as never)
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe(`the locks capability (${EXPERIMENTAL_LOCKS_ENV_VAR})`, () => {
  const original = process.env[EXPERIMENTAL_LOCKS_ENV_VAR];
  afterEach(() => {
    if (original === undefined) delete process.env[EXPERIMENTAL_LOCKS_ENV_VAR];
    else process.env[EXPERIMENTAL_LOCKS_ENV_VAR] = original;
  });

  it('is absent by default, so lock() fails closed in the runtime', () => {
    delete process.env[EXPERIMENTAL_LOCKS_ENV_VAR];
    expect(createWorld().capabilities?.locks).toBeUndefined();
  });

  it('is declared when opted in', () => {
    process.env[EXPERIMENTAL_LOCKS_ENV_VAR] = '1';
    expect(createWorld().capabilities?.locks).toEqual({ concurrency: true });
  });

  it('declares fifo only with its own opt-in', () => {
    process.env[EXPERIMENTAL_LOCKS_ENV_VAR] = '1';
    process.env[EXPERIMENTAL_LOCKS_FIFO_ENV_VAR] = '1';
    try {
      expect(createWorld().capabilities?.locks).toEqual({
        concurrency: true,
        fifo: true,
      });
      delete process.env[EXPERIMENTAL_LOCKS_ENV_VAR];
      expect(createWorld().capabilities?.locks).toBeUndefined();
    } finally {
      delete process.env[EXPERIMENTAL_LOCKS_FIFO_ENV_VAR];
    }
  });
});
