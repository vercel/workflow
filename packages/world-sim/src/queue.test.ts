import { ValidQueueName } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { createIdFactory } from './ids.js';
import { createSimQueue } from './queue.js';

const TOPIC = ValidQueueName.parse('__wkf_workflow_workflow//./w//demo');

function setup() {
  let now = 1_704_067_200_000;
  const queue = createSimQueue({
    now: () => now,
    ids: createIdFactory(() => now),
    deploymentId: 'dpl_sim',
  });
  return { queue, advance: (ms: number) => (now += ms), nowMs: () => now };
}

describe('sim queue', () => {
  it('records messages without delivering anything', async () => {
    const { queue } = setup();
    await queue.queue(TOPIC, { runId: 'wrun_a' });
    await queue.queue(TOPIC, { runId: 'wrun_b' });
    expect(queue.pending()).toHaveLength(2);
  });

  it('delivers in (readyAt, enqueue order), so ties are still total', async () => {
    const { queue } = setup();
    await queue.queue(TOPIC, { runId: 'later' }, { delaySeconds: 60 });
    await queue.queue(TOPIC, { runId: 'first' });
    await queue.queue(TOPIC, { runId: 'second' });

    expect(queue.takeNext()?.payload).toMatchObject({ runId: 'first' });
    expect(queue.takeNext()?.payload).toMatchObject({ runId: 'second' });
    expect(queue.takeNext()?.payload).toMatchObject({ runId: 'later' });
    expect(queue.takeNext()).toBeUndefined();
  });

  it('turns delaySeconds into a virtual ready time', async () => {
    const { queue, nowMs } = setup();
    await queue.queue(TOPIC, { runId: 'wrun_a' }, { delaySeconds: 90 });
    expect(queue.pending()[0].readyAtMs).toBe(nowMs() + 90_000);
  });

  it('dedupes on an idempotency key until the message settles', async () => {
    const { queue } = setup();
    const a = await queue.queue(
      TOPIC,
      { runId: 'wrun_a' },
      { idempotencyKey: 'k' }
    );
    const b = await queue.queue(
      TOPIC,
      { runId: 'wrun_a' },
      { idempotencyKey: 'k' }
    );
    expect(b.messageId).toBe(a.messageId);
    expect(queue.pending()).toHaveLength(1);

    // Wait-continuation logic depends on the key being reusable once the
    // message is done — a wider dedupe window silently drops re-enqueues.
    const message = queue.takeNext();
    if (!message) throw new Error('expected a pending message');
    queue.settle(message);
    const c = await queue.queue(
      TOPIC,
      { runId: 'wrun_a' },
      { idempotencyKey: 'k' }
    );
    expect(c.messageId).not.toBe(a.messageId);
  });

  it('keeps the messageId stable across redeliveries', async () => {
    const { queue, nowMs } = setup();
    await queue.queue(TOPIC, { runId: 'wrun_a' });
    const first = queue.takeNext();
    if (!first) throw new Error('expected a pending message');
    // Inline step ownership uses the messageId as a liveness lease, so a
    // redelivery that minted a fresh id would break crash recovery.
    queue.requeue(first, nowMs() + 5_000);
    expect(queue.pending()[0].messageId).toBe(first.messageId);
  });

  it('round-trips Uint8Array payloads through the wire encoding', async () => {
    const { queue } = setup();
    await queue.queue(TOPIC, {
      runId: 'wrun_a',
      runInput: {
        input: new Uint8Array([1, 2, 3]),
        deploymentId: 'dpl_sim',
        workflowName: 'workflow//./w//demo',
        specVersion: 5,
      },
    });
    const message = queue.takeNext();
    const payload = message?.payload as { runInput: { input: Uint8Array } };
    expect(payload.runInput.input).toBeInstanceOf(Uint8Array);
    expect([...payload.runInput.input]).toEqual([1, 2, 3]);
  });
});
