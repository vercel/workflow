import {
  HOOK_RESUME_INPUT_VERSION,
  type Hook,
  SPEC_VERSION_CURRENT,
  type World,
} from '@workflow/world';
import { EntityConflictError, ThrottleError } from '@workflow/errors';
import { describe, expect, it, vi } from 'vitest';

import { resumeHook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));

describe('active-step abort resume', () => {
  it('records the matching system abort receipt before delivering the live packet', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const event = vi
      .fn()
      .mockImplementation(async (_runId, request, options) => {
        expect(write).not.toHaveBeenCalled();
        return {
          event: {
            ...request,
            resumeId: options.resumeId,
          },
        };
      });
    const queue = vi.fn().mockResolvedValue(undefined);
    const hook = {
      createdAt: new Date(),
      environment: 'test',
      hookId: 'hook_active_abort',
      isSystem: true,
      ownerId: 'owner',
      projectId: 'project',
      resumeContext: {
        deploymentId: 'deployment',
        runSpecVersion: 5,
        workflowCoreVersion: '5.0.0-beta.41',
        workflowName: 'activeAbort',
        hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
      },
      runId: 'wrun_active_abort',
      specVersion: SPEC_VERSION_CURRENT,
      token: 'abrt_active_abort',
    } satisfies Hook;

    setWorld({
      events: { create: event },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      capabilities: { hookResumeDedup: true },
      queue,
      specVersion: SPEC_VERSION_CURRENT,
      streams: { close, write },
    } as unknown as World);

    await resumeHook(hook.token, { name: 'TurnCancelledError' });

    expect(write).toHaveBeenCalledWith(
      'wrun_active_abort',
      'strm_active_abort_system_abort',
      expect.any(Uint8Array)
    );
    // A cancellation packet is terminal at the reader. Retrying a writer-side
    // close would reuse an already-terminal stream after ambiguous delivery.
    expect(close).not.toHaveBeenCalled();
    expect(event).toHaveBeenCalledOnce();
    expect(queue).toHaveBeenCalledOnce();
    const [, , receiptOptions] = event.mock.calls[0];
    const [, wake] = queue.mock.calls[0];
    expect(receiptOptions.resumeId).toBe('hook_active_abort');
    expect(receiptOptions.resumePayloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(wake.hookInput).toMatchObject({
      resumeId: 'hook_active_abort',
      hookId: 'hook_active_abort',
      token: 'abrt_active_abort',
      payloadDigest: receiptOptions.resumePayloadDigest,
    });
    setWorld(undefined);
  });

  it('does not deliver a live abort when its durable receipt cannot be written', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const eventFailure = new Error('event unavailable');
    const event = vi.fn().mockRejectedValue(eventFailure);
    const queue = vi.fn().mockResolvedValue(undefined);
    const hook = {
      createdAt: new Date(),
      environment: 'test',
      hookId: 'hook_active_abort',
      isSystem: true,
      ownerId: 'owner',
      projectId: 'project',
      resumeContext: {
        deploymentId: 'deployment',
        runSpecVersion: 5,
        workflowCoreVersion: '5.0.0-beta.41',
        workflowName: 'activeAbort',
        hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
      },
      runId: 'wrun_active_abort',
      specVersion: SPEC_VERSION_CURRENT,
      token: 'abrt_active_abort',
    } satisfies Hook;

    setWorld({
      events: { create: event },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      capabilities: { hookResumeDedup: true },
      queue,
      specVersion: SPEC_VERSION_CURRENT,
      streams: { close, write },
    } as unknown as World);

    await expect(
      resumeHook(hook.token, { name: 'TurnCancelledError' })
    ).rejects.toBe(eventFailure);

    expect(write).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    setWorld(undefined);
  });

  it('wakes the durable abort receipt when live stream delivery fails', async () => {
    const streamFailure = new Error('stream unavailable');
    const write = vi.fn().mockRejectedValue(streamFailure);
    const close = vi.fn().mockResolvedValue(undefined);
    const event = vi
      .fn()
      .mockImplementation(async (_runId, request, options) => ({
        event: { ...request, resumeId: options.resumeId },
      }));
    const queue = vi.fn().mockResolvedValue(undefined);
    const hook = {
      createdAt: new Date(),
      environment: 'test',
      hookId: 'hook_active_abort',
      isSystem: true,
      ownerId: 'owner',
      projectId: 'project',
      resumeContext: {
        deploymentId: 'deployment',
        runSpecVersion: 5,
        workflowCoreVersion: '5.0.0-beta.41',
        workflowName: 'activeAbort',
        hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
      },
      runId: 'wrun_active_abort',
      specVersion: SPEC_VERSION_CURRENT,
      token: 'abrt_active_abort',
    } satisfies Hook;

    setWorld({
      events: { create: event },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      capabilities: { hookResumeDedup: true },
      queue,
      specVersion: SPEC_VERSION_CURRENT,
      streams: { close, write },
    } as unknown as World);

    await expect(
      resumeHook(hook.token, { name: 'TurnCancelledError' })
    ).rejects.toBe(streamFailure);

    expect(event).toHaveBeenCalledOnce();
    expect(queue).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    setWorld(undefined);
  });

  it('retries a failed wake against the one durable abort receipt', async () => {
    const queueFailure = new Error('queue unavailable');
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const event = vi
      .fn()
      .mockImplementation(async (_runId, request, options) => ({
        event: { ...request, resumeId: options.resumeId },
      }));
    const queue = vi
      .fn()
      .mockRejectedValueOnce(queueFailure)
      .mockResolvedValueOnce(undefined);
    const hook = {
      createdAt: new Date(),
      environment: 'test',
      hookId: 'hook_active_abort',
      isSystem: true,
      ownerId: 'owner',
      projectId: 'project',
      resumeContext: {
        deploymentId: 'deployment',
        runSpecVersion: 5,
        workflowCoreVersion: '5.0.0-beta.41',
        workflowName: 'activeAbort',
        hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
      },
      runId: 'wrun_active_abort',
      specVersion: SPEC_VERSION_CURRENT,
      token: 'abrt_active_abort',
    } satisfies Hook;

    setWorld({
      events: { create: event },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      capabilities: { hookResumeDedup: true },
      queue,
      specVersion: SPEC_VERSION_CURRENT,
      streams: { close, write },
    } as unknown as World);

    await expect(
      resumeHook(hook.token, { name: 'TurnCancelledError' })
    ).rejects.toBe(queueFailure);
    await expect(
      resumeHook(hook.token, { name: 'TurnCancelledError' })
    ).resolves.toMatchObject({ hookId: hook.hookId });

    expect(event).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledTimes(2);
    setWorld(undefined);
  });

  it('retries an ambiguous receipt response with the stable claim', async () => {
    const hook = {
      createdAt: new Date(),
      environment: 'test',
      hookId: 'hook_active_abort',
      isSystem: true,
      ownerId: 'owner',
      projectId: 'project',
      runId: 'wrun_active_abort',
      specVersion: SPEC_VERSION_CURRENT,
      token: 'abrt_active_abort',
      resumeContext: {
        deploymentId: 'deployment',
        runSpecVersion: 5,
        workflowCoreVersion: '5.0.0-beta.41',
        workflowName: 'activeAbort',
        hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
      },
    } satisfies Hook;
    const event = vi
      .fn()
      .mockRejectedValueOnce(new ThrottleError('response lost'))
      .mockImplementationOnce(async (_runId, request, options) => ({
        event: { ...request, resumeId: options.resumeId },
      }));
    const write = vi.fn().mockResolvedValue(undefined);
    const queue = vi.fn().mockResolvedValue(undefined);
    setWorld({
      capabilities: { hookResumeDedup: true },
      events: { create: event },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      queue,
      specVersion: SPEC_VERSION_CURRENT,
      streams: { write },
    } as unknown as World);

    await resumeHook(hook.token, { name: 'TurnCancelledError' });

    expect(event).toHaveBeenCalledTimes(2);
    const [, , first] = event.mock.calls[0];
    const [, , second] = event.mock.calls[1];
    expect(second.resumeId).toBe(first.resumeId);
    expect(second.resumePayloadDigest).toBe(first.resumePayloadDigest);
    expect(queue).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
  });

  it('does not treat a foreign receipt conflict as a cancellation receipt', async () => {
    const hook = {
      createdAt: new Date(),
      environment: 'test',
      hookId: 'hook_active_abort',
      isSystem: true,
      ownerId: 'owner',
      projectId: 'project',
      runId: 'wrun_active_abort',
      specVersion: SPEC_VERSION_CURRENT,
      token: 'abrt_active_abort',
      resumeContext: {
        deploymentId: 'deployment',
        runSpecVersion: 5,
        workflowCoreVersion: '5.0.0-beta.41',
        workflowName: 'activeAbort',
        hookResumeInputVersion: HOOK_RESUME_INPUT_VERSION,
      },
    } satisfies Hook;
    const conflict = new EntityConflictError('foreign receipt');
    const write = vi.fn();
    const queue = vi.fn();
    setWorld({
      capabilities: { hookResumeDedup: true },
      events: { create: vi.fn().mockRejectedValue(conflict) },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      queue,
      specVersion: SPEC_VERSION_CURRENT,
      streams: { write },
    } as unknown as World);

    await expect(
      resumeHook(hook.token, { name: 'TurnCancelledError' })
    ).rejects.toBe(conflict);
    expect(queue).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
