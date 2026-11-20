import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { QueueClient } from '@vercel/queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueueDispatcher } from './http-client.js';
import { createQueue } from './queue.js';
import {
  markQueueReschedule,
  QUEUE_EDGE_DENY_RETRY_DELAY_MS,
  runQueueDelivery,
  setQueueEdgeDenyRetryDelayForTests,
} from './queue-edge-deny-retry.js';

// Drives the real `@vercel/queue` client over real HTTP through world-vercel's
// own queue dispatcher, against a local server standing in for Vercel Queues.
// A pushed delivery whose handler fails is rescheduled with a lease PATCH; the
// server decides how that PATCH is answered.

type Answer = 'ok' | 'edge-deny' | 'queue-forbidden';

interface Seen {
  method: string;
  url: string;
  body: string;
}

const RETRY_DELAY_FOR_TESTS_MS = 50;

describe('createQueueHandler: a 403 on the retry reschedule (#4829)', () => {
  let server: http.Server;
  let seen: Seen[];
  let answers: Answer[];

  beforeEach(async () => {
    seen = [];
    answers = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', body });
        const answer = answers.shift() ?? 'ok';
        if (answer === 'edge-deny') {
          // What the Vercel Firewall answers: the request never reached Vercel
          // Queues, and the edge marks the response as mitigated.
          res.writeHead(403, {
            'content-type': 'text/plain',
            'x-vercel-mitigated': 'deny',
          });
          res.end('Forbidden');
        } else if (answer === 'queue-forbidden') {
          // A 403 Vercel Queues itself decided.
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    vi.stubEnv('WORKFLOW_VERCEL_BACKEND_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_test');
    vi.stubEnv('VERCEL_REGION', 'iad1');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    setQueueEdgeDenyRetryDelayForTests(RETRY_DELAY_FOR_TESTS_MS);
  });

  afterEach(async () => {
    setQueueEdgeDenyRetryDelayForTests(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    server.close();
    await once(server, 'close');
  });

  /** A pushed (binary mode) delivery whose payload the handler rejects. */
  const pushedDelivery = () =>
    new Request('http://localhost/.well-known/workflow/v1/flow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'ce-type': 'com.vercel.queue.v2beta',
        'ce-vqsqueuename': '__wkf_workflow_test',
        'ce-vqsconsumergroup': 'default',
        'ce-vqsmessageid': 'msg-4829',
        'ce-vqsreceipthandle': 'rh-4829',
        'ce-vqsdeliverycount': '1',
        'ce-vqscreatedat': new Date().toISOString(),
        'ce-vqsregion': 'iad1',
      },
      body: JSON.stringify({ not: 'a workflow message' }),
    });

  const deliver = async () => {
    const queue = createQueue({
      dispatcher: createQueueDispatcher(),
      projectConfig: { projectId: 'prj_test', teamId: 'team_test' },
      token: 'test-token',
    });
    const route = queue.createQueueHandler('__wkf_workflow_', vi.fn());
    return route(pushedDelivery());
  };

  const leasePatches = () =>
    seen.filter((r) => r.method === 'PATCH' && r.url.includes('/lease/'));

  it('retries a reschedule the Vercel edge refused, once, after the delay', async () => {
    answers = ['edge-deny', 'ok'];

    const startedAt = Date.now();
    const response = await deliver();

    expect(response.status).toBe(200);
    const patches = leasePatches();
    expect(patches).toHaveLength(2);
    expect(patches[0]?.url).toContain('/lease/rh-4829');
    // The retry carries the same 1s reschedule as the refused attempt.
    expect(patches.map((p) => JSON.parse(p.body))).toEqual([
      { visibilityTimeoutSeconds: 1 },
      { visibilityTimeoutSeconds: 1 },
    ]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
      RETRY_DELAY_FOR_TESTS_MS
    );
    expect(console.warn).not.toHaveBeenCalledWith(
      'Failed to reschedule message for retry:',
      expect.anything()
    );
  });

  it('retries only once when the edge refuses the retry too', async () => {
    answers = ['edge-deny', 'edge-deny', 'ok'];

    const response = await deliver();

    expect(response.status).toBe(200);
    expect(leasePatches()).toHaveLength(2);
    expect(console.warn).toHaveBeenCalledWith(
      'Failed to reschedule message for retry:',
      expect.objectContaining({ name: 'ForbiddenError' })
    );
  });

  it('does not retry a 403 that Vercel Queues itself sent', async () => {
    answers = ['queue-forbidden', 'ok'];

    await deliver();

    expect(leasePatches()).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      'Failed to reschedule message for retry:',
      expect.objectContaining({ name: 'ForbiddenError' })
    );
  });

  // The same dispatcher under the queue client's API directly, for the
  // requests a delivery makes besides the reschedule.
  const apiClient = () => {
    const { port } = server.address() as AddressInfo;
    const client = new QueueClient({
      region: 'iad1',
      token: 'test-token',
      deploymentId: 'dpl_test',
      resolveBaseUrl: () => new URL(`http://127.0.0.1:${port}`),
      dispatcher: createQueueDispatcher(),
    });
    return (client as unknown as Record<symbol, unknown>)[
      Symbol.for('@vercel/queue.apiClient')
    ] as {
      changeVisibility(options: object): Promise<unknown>;
      acknowledgeMessage(options: object): Promise<unknown>;
    };
  };
  const lease = {
    messageId: 'msg-4829',
    queueName: '__wkf_workflow_test',
    consumerGroup: 'default',
    receiptHandle: 'rh-4829',
  };

  it('does not retry a lease extension the edge refused', async () => {
    answers = ['edge-deny', 'ok'];
    const api = apiClient();

    // A lease PATCH before the `retry` hook ran is an extension.
    await expect(
      runQueueDelivery(() =>
        api.changeVisibility({ ...lease, visibilityTimeoutSeconds: 300 })
      )
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(leasePatches()).toHaveLength(1);
  });

  it('does not retry an acknowledgement the edge refused', async () => {
    answers = ['edge-deny', 'ok'];
    const api = apiClient();

    await expect(
      runQueueDelivery(async () => {
        markQueueReschedule();
        await api.acknowledgeMessage(lease);
      })
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(seen).toHaveLength(1);
  });

  it('does not retry outside a queue delivery', async () => {
    answers = ['edge-deny', 'ok'];
    const api = apiClient();

    markQueueReschedule();
    await expect(
      api.changeVisibility({ ...lease, visibilityTimeoutSeconds: 1 })
    ).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(leasePatches()).toHaveLength(1);
  });

  it('waits 10 seconds by default', () => {
    expect(QUEUE_EDGE_DENY_RETRY_DELAY_MS).toBe(10_000);
  });
});
