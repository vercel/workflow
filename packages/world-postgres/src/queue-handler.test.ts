import {
  MessageId,
  type QueuePrefix,
  queueDeliveryHeaders,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { createDeliveryHandler, createRunGate } from './queue-handler.js';

/**
 * The HTTP shape of a delivery (a worker on an earlier release delivering
 * over HTTP while `WORKFLOW_QUEUE_AUTH=off`) shares the run gate with the
 * in-process path, and the same rule: a delivery whose request was aborted
 * while it waited for the gate is not run once the gate frees up.
 */
describe('createDeliveryHandler', () => {
  const prefix = '__wkf_workflow_' as QueuePrefix;
  const delivery = (messageId: string, init: RequestInit = {}) =>
    new Request('http://app.test/.well-known/workflow/v1/flow', {
      method: 'POST',
      headers: queueDeliveryHeaders({
        queueName: `${prefix}test`,
        messageId: MessageId.parse(messageId),
        attempt: 1,
        deliveryCount: 1,
      }),
      body: JSON.stringify({ runId: 'run_01ABC', runSpecVersion: 9 }),
      ...init,
    });
  const deserialize = async (stream: ReadableStream<Uint8Array>) =>
    JSON.parse(await new Response(stream).text());

  it('does not run a delivery whose request was aborted while it waited for the run gate', async () => {
    const holdA = Promise.withResolvers<void>();
    const ran: string[] = [];
    const handle = createDeliveryHandler(
      prefix,
      async (_message, meta) => {
        ran.push(String(meta.messageId));
        if (ran.length === 1) await holdA.promise;
      },
      { runGate: createRunGate(), deserialize }
    );
    const a = handle(delivery('msg_01A'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(ran).toEqual(['msg_01A']);
    // B waits for the gate; its sender gives up (the request is aborted)
    // before A lets go.
    const abortB = new AbortController();
    const b = handle(delivery('msg_01B', { signal: abortB.signal }));
    abortB.abort();
    holdA.resolve();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(503);
    // B never ran, and the gate is free for C.
    expect((await handle(delivery('msg_01C'))).status).toBe(200);
    expect(ran).toEqual(['msg_01A', 'msg_01C']);
  });
});
