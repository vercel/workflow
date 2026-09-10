import { waitForHook, waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { getRun, resumeWebhook, start } from 'workflow/api';
import { paymentWebhook } from '../workflows/patterns/webhooks-event-listener.js';
import { asyncVerification } from '../workflows/patterns/webhooks-request-reply.js';

const RUN = Date.now().toString(36);

function jsonRequest(body: unknown): Request {
  return new Request('https://example.com/webhook', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('webhooks — event listener pattern', () => {
  it('processes a sequence of events, responds to each, and settles on a terminal event', async () => {
    const orderId = `order-${RUN}`;
    const run = await start(paymentWebhook, [orderId]);

    // The webhook URL stays stable for the run's lifetime — both events go
    // to the same token.
    const hook = await waitForHook(run);

    // Non-terminal event: acknowledged with the manual response, loop continues.
    const first = await resumeWebhook(
      hook.token,
      jsonRequest({ type: 'payment.failed' })
    );
    expect(await first.json()).toEqual({ ack: true, action: 'flagged' });

    // Terminal event: acknowledged, then the loop breaks.
    const second = await resumeWebhook(
      hook.token,
      jsonRequest({ type: 'payment.succeeded' })
    );
    expect(await second.json()).toEqual({ ack: true, action: 'captured' });

    const result = await run.returnValue;
    expect(result.orderId).toBe(orderId);
    expect(result.status).toBe('settled');
    expect(result.webhookUrl).toContain(hook.token);
    expect(result.ledger.map((entry: { type: string }) => entry.type)).toEqual([
      'payment.failed',
      'payment.succeeded',
    ]);
  });
});

describe('webhooks — async request-reply pattern', () => {
  it('returns verified when the vendor callback approves in time', async () => {
    const documentId = `doc-${RUN}-ok`;
    const run = await start(asyncVerification, [documentId]);

    const hook = await waitForHook(run);
    const response = await resumeWebhook(
      hook.token,
      jsonRequest({ approved: true, details: 'all checks passed' })
    );
    expect(await response.json()).toEqual({ ack: true });

    const result = await run.returnValue;
    expect(result).toEqual({
      documentId,
      status: 'verified',
      details: 'all checks passed',
    });
  });

  it('returns rejected when the vendor callback declines', async () => {
    const documentId = `doc-${RUN}-no`;
    const run = await start(asyncVerification, [documentId]);

    const hook = await waitForHook(run);
    await resumeWebhook(
      hook.token,
      jsonRequest({ approved: false, reason: 'blurry photo' })
    );

    const result = await run.returnValue;
    expect(result).toEqual({
      documentId,
      status: 'rejected',
      details: 'blurry photo',
    });
  });

  it('times out gracefully when the callback never arrives', async () => {
    const documentId = `doc-${RUN}-late`;
    const run = await start(asyncVerification, [documentId]);

    // Ensure the webhook is registered, then expire the 30s deadline sleep.
    await waitForHook(run);
    const sleepId = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    const result = await run.returnValue;
    expect(result).toEqual({ documentId, status: 'timed_out' });
  });
});
