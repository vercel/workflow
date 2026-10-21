import { describe, expect, it } from 'vitest';
import { CreateEventSchema } from './events.js';
import { RunInputSchema } from './queue.js';
import { WorkflowRunSchema } from './runs.js';
import { StartHookSchema } from './start-hook.js';

const tokenRetentionUntil = '2026-11-01T00:00:00.000Z';

describe('start Hook schemas', () => {
  it('requires a non-empty string token', () => {
    expect(StartHookSchema.safeParse({ token: '' }).success).toBe(false);
    expect(StartHookSchema.safeParse({ token: 42 }).success).toBe(false);
    expect(StartHookSchema.safeParse({ token: 'order:1' }).success).toBe(true);
  });

  it('parses the reservation on run_created, with an absolute retention', () => {
    const parsed = CreateEventSchema.parse({
      eventType: 'run_created',
      specVersion: 8,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        input: new Uint8Array(),
        startHook: { token: 'order:1', tokenRetentionUntil },
      },
    });
    expect(parsed.eventType).toBe('run_created');
    expect(
      parsed.eventType === 'run_created' && parsed.eventData.startHook
    ).toEqual({
      token: 'order:1',
      tokenRetentionUntil: new Date(tokenRetentionUntil),
    });
  });

  it('parses the reservation on a resilient run_started', () => {
    const parsed = CreateEventSchema.parse({
      eventType: 'run_started',
      specVersion: 8,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        input: new Uint8Array(),
        startHook: { token: 'order:1' },
      },
    });
    expect(
      parsed.eventType === 'run_started' && parsed.eventData?.startHook
    ).toEqual({ token: 'order:1' });
  });

  it('keeps the reservation and the public key on the queued run input', () => {
    const parsed = RunInputSchema.parse({
      input: new Uint8Array(),
      deploymentId: 'dpl_1',
      workflowName: 'wf',
      specVersion: 8,
      encryptionPublicKey: 'pk',
      startHook: { token: 'order:1', tokenRetentionUntil },
    });
    expect(parsed.startHook).toEqual({
      token: 'order:1',
      tokenRetentionUntil: new Date(tokenRetentionUntil),
    });
    expect(parsed.encryptionPublicKey).toBe('pk');
  });

  it('round-trips the echo on a run', () => {
    const now = new Date();
    const run = WorkflowRunSchema.parse({
      runId: 'wrun_1',
      status: 'pending',
      deploymentId: 'dpl_1',
      workflowName: 'wf',
      createdAt: now,
      updatedAt: now,
      startHook: { token: 'order:1' },
    });
    expect(run.startHook).toEqual({ token: 'order:1' });
  });
});
