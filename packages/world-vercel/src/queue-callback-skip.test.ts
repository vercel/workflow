import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueue } from './queue.js';

// Exercises the real `@vercel/queue` callback path (no module mock): VQS
// delivers a callback, the consumer tries to claim the message by id, and the
// claim is rejected because another consumer already holds or finished it.
// That is an expected outcome under concurrent delivery and must not surface
// as a 500 from the flow/step route.
describe('createQueueHandler: unclaimable callback deliveries', () => {
  // `@vercel/queue` only checks that the OIDC token is an unexpired JWT.
  const b64 = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const fakeOidcToken = `${b64({ alg: 'none' })}.${b64({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.sig`;

  beforeEach(() => {
    vi.stubEnv('VERCEL_OIDC_TOKEN', fakeOidcToken);
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_test');
    vi.stubEnv('VERCEL_REGION', 'iad1');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const callbackRequest = () =>
    new Request('http://localhost/.well-known/workflow/v1/flow', {
      method: 'POST',
      headers: { 'content-type': 'application/cloudevents+json' },
      body: JSON.stringify({
        type: 'com.vercel.queue.v1beta',
        source: '/topic/__wkf_workflow_test/consumer/default',
        id: 'evt-1',
        data: {
          queueName: '__wkf_workflow_test',
          consumerGroup: 'default',
          messageId: 'msg-123',
        },
      }),
    });

  it.each([
    [409, 'not_available'],
    [410, 'already_processed'],
  ])('responds 200 (not 500) when claiming the message returns %i', async (status, reason) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn();

    const route = createQueue().createQueueHandler('__wkf_workflow_', handler);
    const response = await route(callbackRequest());

    // The claim-by-id request reached VQS and was rejected.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/id/msg-123');
    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'skipped',
      reason,
    });
    expect(console.error).not.toHaveBeenCalled();
  });
});
