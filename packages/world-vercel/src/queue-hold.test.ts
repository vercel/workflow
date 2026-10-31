import { SPEC_VERSION_SINGLE_ORCHESTRATOR } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend, MockQueueClient } = vi.hoisted(() => {
  const mockSend = vi.fn();
  // biome-ignore lint/complexity/useArrowFunction: needs to be newable
  const MockQueueClient = vi.fn().mockImplementation(function () {
    return { send: mockSend, handleCallback: vi.fn() };
  });
  return { mockSend, MockQueueClient };
});

vi.mock('@vercel/queue', () => ({
  ConcurrencyCoalescedPendingError: class extends Error {},
  ConsumerDiscoveryError: class extends Error {},
  QueueClient: MockQueueClient,
}));

vi.mock('./utils.js', () => ({
  getHttpUrl: vi
    .fn()
    .mockReturnValue({ baseUrl: 'http://localhost:3000', usingProxy: false }),
  getHeaders: vi.fn().mockReturnValue(new Map()),
}));

import { createWorld } from './index.js';
import {
  createQueue,
  DEFAULT_MESSAGE_RETENTION_SECONDS,
  HOLD_CONSUMER_GROUP,
  resolveHoldOptions,
  vercelTriggerConsumerGroup,
} from './queue.js';

const sendOptionsOf = (call = 0) => mockSend.mock.calls[call][2];

describe('send-and-hold (experimental_hold)', () => {
  const originalDeploymentId = process.env.VERCEL_DEPLOYMENT_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test';
  });

  afterEach(() => {
    if (originalDeploymentId === undefined) {
      delete process.env.VERCEL_DEPLOYMENT_ID;
    } else {
      process.env.VERCEL_DEPLOYMENT_ID = originalDeploymentId;
    }
  });

  it('is declared as a World capability', () => {
    expect(createWorld().capabilities?.experimental_queueHold).toBe(true);
  });

  it('asks for no hold unless the caller does', async () => {
    mockSend.mockResolvedValue({ messageId: 'msg_1' });
    const result = await createQueue().queue('__wkf_workflow_test', {
      runId: 'wrun_1',
    });
    expect(sendOptionsOf()).not.toHaveProperty('experimental_hold');
    expect(result).toEqual({ messageId: 'msg_1' });
  });

  it("claims the message for the Workflow SDK's consumer group", async () => {
    mockSend.mockResolvedValue({
      messageId: 'msg_1',
      experimental_notHeld: { reason: 'unsupported' },
    });
    const result = await createQueue().queue(
      '__wkf_workflow_test',
      { runId: 'wrun_1' },
      { idempotencyKey: 'k', experimental_hold: {} }
    );
    expect(sendOptionsOf().experimental_hold).toEqual({
      consumerGroup: HOLD_CONSUMER_GROUP,
    });
    expect(sendOptionsOf().idempotencyKey).toBe('k');
    expect(result).toEqual({
      messageId: 'msg_1',
      experimental_notHeld: { reason: 'unsupported' },
    });
  });

  it('refuses a hold with a delay before anything is sent', async () => {
    await expect(
      createQueue().queue(
        '__wkf_workflow_test',
        { runId: 'wrun_1' },
        { delaySeconds: 5, experimental_hold: {} }
      )
    ).rejects.toThrow(TypeError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  describe('a held message', () => {
    const leaseExpiresAt = new Date('2026-10-30T12:00:30Z');
    const sendHeld = async (payload: Record<string, unknown>) => {
      const consume = vi.fn().mockResolvedValue(undefined);
      const release = vi.fn().mockResolvedValue(undefined);
      mockSend.mockResolvedValue({
        messageId: 'msg_1',
        experimental_held: {
          messageId: 'msg_1',
          consumerGroup: HOLD_CONSUMER_GROUP,
          receiptHandle: 'rh_1',
          deliveryCount: 1,
          leaseExpiresAt,
          consume,
          release,
        },
      });
      const result = await createQueue().queue('__wkf_workflow_test', payload, {
        experimental_hold: { visibilityTimeoutSeconds: 60 },
      });
      return { result, consume, release };
    };

    it('is returned with its id and lease, and nothing that holds the token', async () => {
      const { result } = await sendHeld({ runId: 'wrun_1' });
      expect(result.experimental_held).toMatchObject({
        messageId: 'msg_1',
        leaseExpiresAt,
      });
      expect(Object.keys(result.experimental_held ?? {}).sort()).toEqual([
        'consume',
        'leaseExpiresAt',
        'messageId',
        'release',
      ]);
      expect(sendOptionsOf().experimental_hold).toEqual({
        consumerGroup: HOLD_CONSUMER_GROUP,
        visibilityTimeoutSeconds: 60,
      });
    });

    it('runs the handler as a pushed delivery would, with the same retry directives', async () => {
      const payload = {
        runId: 'wrun_1',
        runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      };
      const { result, consume } = await sendHeld(payload);
      const handler = vi.fn().mockResolvedValue({ timeoutSeconds: 7 });
      await result.experimental_held?.consume(handler);

      expect(consume).toHaveBeenCalledTimes(1);
      const [callback, options] = consume.mock.calls[0];
      expect(options).toEqual({
        experimental_maxCoalescedReruns: expect.any(Number),
        retry: expect.any(Function),
      });

      // The queue client hands the callback the wrapper that was sent.
      const wrapper = mockSend.mock.calls[0][1];
      const error = await callback(wrapper, {
        messageId: 'msg_1',
        deliveryCount: 1,
        createdAt: new Date(),
      }).catch((err: unknown) => err);
      expect(handler).toHaveBeenCalledWith(
        payload,
        expect.objectContaining({
          queueName: '__wkf_workflow_test',
          messageId: 'msg_1',
          attempt: 1,
          deliveryCount: 1,
        })
      );
      // A spec 9 `{ timeoutSeconds }` redelivers the same message.
      expect(
        options.retry(error, { messageId: 'msg_1', deliveryCount: 1 })
      ).toEqual({ afterSeconds: 7 });
    });

    it('is released through the queue client', async () => {
      const { result, release } = await sendHeld({ runId: 'wrun_1' });
      await result.experimental_held?.release(3);
      expect(release).toHaveBeenCalledWith(3);
    });
  });
});

describe('resolveHoldOptions', () => {
  it('is undefined without a hold', () => {
    expect(resolveHoldOptions(undefined, {})).toBeUndefined();
    expect(resolveHoldOptions({}, {})).toBeUndefined();
  });

  it("leaves the lease to the queue's default when none is asked for", () => {
    expect(resolveHoldOptions({ experimental_hold: {} }, {})).toEqual({
      consumerGroup: HOLD_CONSUMER_GROUP,
    });
  });

  it('clamps the lease to what Vercel Queues accepts', () => {
    const lease = (seconds: number, retentionSeconds?: number) =>
      resolveHoldOptions(
        { experimental_hold: { visibilityTimeoutSeconds: seconds } },
        retentionSeconds === undefined ? {} : { retentionSeconds }
      )?.visibilityTimeoutSeconds;
    expect(lease(1)).toBe(30);
    expect(lease(45.2)).toBe(46);
    expect(lease(DEFAULT_MESSAGE_RETENTION_SECONDS)).toBe(3600);
    // Never past the message's retention.
    expect(lease(600, 120)).toBe(120);
  });

  it('refuses a delay', () => {
    expect(() =>
      resolveHoldOptions({ experimental_hold: {} }, { delaySeconds: 1 })
    ).toThrow(TypeError);
  });
});

describe('the hold consumer group', () => {
  it("defaults to the generated triggers' group, and takes the caller's", () => {
    expect(resolveHoldOptions({ experimental_hold: {} }, {})).toEqual({
      consumerGroup: 'default',
    });
    expect(
      resolveHoldOptions(
        {
          experimental_hold: {
            consumerGroup: 'app_Sapi_Slibfx_Sroute_Dts',
            visibilityTimeoutSeconds: 60,
          },
        },
        {}
      )
    ).toEqual({
      consumerGroup: 'app_Sapi_Slibfx_Sroute_Dts',
      visibilityTimeoutSeconds: 60,
    });
  });

  it('refuses a group Vercel Queues cannot name', () => {
    expect(() =>
      resolveHoldOptions(
        { experimental_hold: { consumerGroup: 'api/flow.ts' } },
        {}
      )
    ).toThrow(TypeError);
  });

  // Pinned to `sanitizeConsumerName` in @vercel/build-utils 15.2.0, which
  // names the group of a `queue/v2beta` trigger configured in vercel.json.
  it.each([
    ['app/api/libfx/route.ts', undefined, 'app_Sapi_Slibfx_Sroute_Dts'],
    ['api/flow.ts', undefined, 'api_Sflow_Dts'],
    [
      'app/.well-known/durable-harness/v1/flow/route.ts',
      undefined,
      'app_S_Dwell-known_Sdurable-harness_Sv1_Sflow_Sroute_Dts',
    ],
    [
      'app/api/sessions/*/live/route.ts',
      undefined,
      'app_Sapi_Ssessions_S_2A_Slive_Sroute_Dts',
    ],
    ['api/my_fn.ts', undefined, 'api_Smy__fn_Dts'],
    ['api/flow.ts', 'web', 'web_7Eapi_Sflow_Dts'],
  ])('names %s (service %s) %s', (pattern, service, group) => {
    expect(vercelTriggerConsumerGroup(pattern, service)).toBe(group);
  });
});
