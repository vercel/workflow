import { describe, expect, it, vi } from 'vitest';
import { createFetchQueueHandler } from './queue-http.js';
import { serializeQueueMessage } from './queue-json.js';

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/.well-known/workflow/v1/flow', {
    method: 'POST',
    headers: {
      'x-vqs-message-attempt': '2',
      'x-vqs-message-id': 'msg_01ABC',
      'x-vqs-queue-name': '__wkf_workflow_test',
      ...headers,
    },
    body: serializeQueueMessage(body),
  });
}

describe('createFetchQueueHandler', () => {
  it('decodes a delivery and preserves its metadata', async () => {
    const handler = vi.fn(async () => undefined);
    const route = createFetchQueueHandler('__wkf_workflow_', handler);
    const req = request({ bytes: new Uint8Array([1, 2, 3]) });

    const response = await route(req);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith(
      { bytes: new Uint8Array([1, 2, 3]) },
      {
        abortSignal: req.signal,
        attempt: 2,
        messageId: 'msg_01ABC',
        queueName: '__wkf_workflow_test',
      }
    );
  });

  it('clamps a requested redelivery delay', async () => {
    const route = createFetchQueueHandler(
      '__wkf_workflow_',
      async () => ({ timeoutSeconds: 60 }),
      { maxTimeoutSeconds: 10 }
    );

    await expect(
      (await route(request({ runId: 'wrun_1' }))).json()
    ).resolves.toEqual({
      timeoutSeconds: 10,
    });
  });

  it('rejects malformed and differently prefixed deliveries', async () => {
    const handler = vi.fn(async () => undefined);
    const route = createFetchQueueHandler('__wkf_workflow_', handler);

    const missingHeaders = await route(
      new Request('https://example.test', { method: 'POST', body: 'x' })
    );
    const wrongPrefix = await route(
      request(
        { runId: 'wrun_1' },
        {
          'x-vqs-queue-name': '__other_wkf_workflow_test',
        }
      )
    );

    expect(missingHeaders.status).toBe(400);
    expect(wrongPrefix.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('turns handler errors into retryable 500 responses', async () => {
    const route = createFetchQueueHandler('__wkf_workflow_', async () => {
      throw new Error('delivery failed');
    });

    const response = await route(request({ runId: 'wrun_1' }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toBe('Error: delivery failed');
  });
});
