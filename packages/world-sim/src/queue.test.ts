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

describe('sim queue: one orchestrator delivery per run', () => {
  it('skips a run’s orchestrator message while that run holds a lease', async () => {
    const { queue } = setup();
    await queue.queue(TOPIC, { runId: 'wrun_a' });
    await queue.queue(TOPIC, { runId: 'wrun_a' });
    await queue.queue(TOPIC, {
      runId: 'wrun_a',
      stepId: 'step_1',
      stepName: 'add',
    });
    await queue.queue(TOPIC, { runId: 'wrun_b' });

    const first = queue.takeNext();
    const lease = await queue.acquireLease(first!);
    expect(lease).toMatchObject({ runId: 'wrun_a', expired: false });

    // The second orchestrator message of wrun_a waits; the step message and
    // the other run do not.
    expect(queue.takeNext()?.payload).toMatchObject({ stepId: 'step_1' });
    expect(queue.takeNext()?.payload).toMatchObject({ runId: 'wrun_b' });
    expect(queue.takeNext()).toBeUndefined();
    expect(queue.gated()).toHaveLength(1);

    queue.releaseLease(lease);
    expect(queue.takeNext()?.payload).toMatchObject({ runId: 'wrun_a' });
  });

  it('makes a second lease of the run wait for the first', async () => {
    const { queue } = setup();
    await queue.queue(TOPIC, { runId: 'wrun_a' });
    await queue.queue(TOPIC, { runId: 'wrun_a' });
    const first = await queue.acquireLease(queue.takeNext()!);
    const waitedFor: string[] = [];
    const second = queue.acquireLease(queue.pending()[0]!, (holder) =>
      waitedFor.push(holder.messageId)
    );
    let acquired = false;
    void second.then(() => {
      acquired = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(acquired).toBe(false);
    expect(waitedFor).toEqual([first?.messageId]);
    queue.releaseLease(first);
    await expect(second).resolves.toMatchObject({ runId: 'wrun_a' });
  });

  it('frees the run when a lease expires, and can redeliver its message', async () => {
    const { queue } = setup();
    await queue.queue(TOPIC, { runId: 'wrun_a' });
    await queue.queue(TOPIC, { runId: 'wrun_a' }, { delaySeconds: 60 });
    const message = queue.takeNext()!;
    message.deliveries++;
    const lease = await queue.acquireLease(message);
    expect(queue.isDeliverable(queue.pending()[0]!)).toBe(false);

    expect(queue.expireLeases('wrun_a', { redeliver: true })).toEqual([lease]);
    // The stalled delivery keeps running; releasing its expired lease later
    // must not free a lease someone else now holds.
    const redelivery = queue.takeNext();
    expect(redelivery).toMatchObject({
      messageId: message.messageId,
      deliveries: 1,
    });
    const successor = await queue.acquireLease(redelivery!);
    queue.releaseLease(lease);
    expect(queue.isDeliverable(queue.pending()[0]!)).toBe(false);
    queue.releaseLease(successor);
    expect(queue.isDeliverable(queue.pending()[0]!)).toBe(true);
  });
});
