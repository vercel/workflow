import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { STEP_DISPATCH_QUEUE_BATCH_SIZE } from '../constants.js';
import { stepDispatchIdempotencyKey } from '../helpers.js';
import { MAX_STEP_MESSAGE_INPUT_BYTES } from './log-state.js';
import {
  sendStepDispatchMessages,
  stepDispatchMessage,
} from './step-message.js';

const run = {
  runId: 'wrun_step_message',
  deploymentId: 'dpl_step_message',
  workflowName: 'workflow',
  specVersion: SPEC_VERSION_CURRENT,
  startedAt: new Date(1_700_000_000_000),
} as WorkflowRun;

const step = { correlationId: 'step_1', stepName: 'someStep' };

describe('stepDispatchMessage', () => {
  it("keys the message on the step's identity and carries its run context", () => {
    const { message, opts } = stepDispatchMessage({
      run,
      step,
      traceCarrier: {},
    });
    expect(message).toMatchObject({
      runId: run.runId,
      stepId: step.correlationId,
      stepName: step.stepName,
      runContext: { deploymentId: run.deploymentId },
    });
    expect(opts.idempotencyKey).toBe(
      stepDispatchIdempotencyKey(step.correlationId, step.stepName)
    );
    expect(opts.retentionSeconds).toBeGreaterThan(0);
    expect('delaySeconds' in opts).toBe(false);
  });

  it('carries the input only while it fits on a binary-transport run', () => {
    const carried = (input: Uint8Array, specVersion = run.specVersion) =>
      'stepInput' in
      stepDispatchMessage({
        run: { ...run, specVersion },
        step: { ...step, input },
        traceCarrier: {},
      }).message;
    expect(carried(new Uint8Array(MAX_STEP_MESSAGE_INPUT_BYTES))).toBe(true);
    expect(carried(new Uint8Array(MAX_STEP_MESSAGE_INPUT_BYTES + 1))).toBe(
      false
    );
    expect(
      carried(new Uint8Array(1), SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT - 1)
    ).toBe(false);
  });

  it('sends the attempt only above 1, and the creation time only on attempt 1', () => {
    const stepCreatedAt = new Date(1_700_000_001_000);
    const first = stepDispatchMessage({
      run,
      step: { ...step, stepAttempt: 1, stepCreatedAt },
      traceCarrier: {},
    }).message;
    expect(first).toMatchObject({ stepCreatedAt: +stepCreatedAt });
    expect('stepAttempt' in first).toBe(false);
    const retry = stepDispatchMessage({
      run,
      step: { ...step, stepAttempt: 2, stepCreatedAt },
      traceCarrier: {},
      delaySeconds: 5,
    });
    expect(retry.message).toMatchObject({ stepAttempt: 2 });
    expect('stepCreatedAt' in retry.message).toBe(false);
    expect(retry.opts.delaySeconds).toBe(5);
  });
});

describe('sendStepDispatchMessages', () => {
  const items = Array.from(
    { length: STEP_DISPATCH_QUEUE_BATCH_SIZE + 1 },
    (_, i) => ({ ...step, correlationId: `step_${i}` })
  );
  const toMessage = (item: (typeof items)[number]) =>
    stepDispatchMessage({ run, step: item, traceCarrier: {} });

  it('splits the messages into queue batches and reports each one sent', async () => {
    const queueBatch = vi.fn(async (_queueName: string, batch: unknown[]) =>
      batch.map(() => ({ messageId: 'msg' }))
    );
    const world = { queueBatch } as unknown as World;
    const sent: string[][] = [];
    await sendStepDispatchMessages(world, 'q', items, toMessage, (batch) =>
      sent.push(batch.map((item) => item.correlationId))
    );
    expect(sent.map((batch) => batch.length).sort()).toEqual([
      1,
      STEP_DISPATCH_QUEUE_BATCH_SIZE,
    ]);
    expect(sent.flat().sort()).toEqual(
      items.map((item) => item.correlationId).sort()
    );
  });

  it('rejects once every batch settled, and reports the batches that went out', async () => {
    let calls = 0;
    const queue = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('send failed');
      return { messageId: 'msg' };
    });
    const world = { queue } as unknown as World;
    const sent: string[] = [];
    await expect(
      sendStepDispatchMessages(world, 'q', items, toMessage, (batch) =>
        sent.push(...batch.map((item) => item.correlationId))
      )
    ).rejects.toThrow('send failed');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(items.length);
  });
});
