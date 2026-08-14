import { type Hook, SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { EntityConflictError } from '@workflow/errors';
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
    const event = vi.fn().mockImplementation(async () => {
      expect(write).not.toHaveBeenCalled();
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
      },
      runId: 'wrun_active_abort',
      specVersion: SPEC_VERSION_CURRENT,
      token: 'abrt_active_abort',
    } satisfies Hook;

    setWorld({
      events: { create: event },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
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
    expect(close).toHaveBeenCalledWith(
      'wrun_active_abort',
      'strm_active_abort_system_abort'
    );
    expect(event).toHaveBeenCalledOnce();
    expect(queue).toHaveBeenCalledOnce();
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
      },
      runId: 'wrun_active_abort',
      specVersion: SPEC_VERSION_CURRENT,
      token: 'abrt_active_abort',
    } satisfies Hook;

    setWorld({
      events: { create: event },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
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
    const event = vi.fn().mockResolvedValue(undefined);
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
      },
      runId: 'wrun_active_abort',
      specVersion: SPEC_VERSION_CURRENT,
      token: 'abrt_active_abort',
    } satisfies Hook;

    setWorld({
      events: { create: event },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
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
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new EntityConflictError('receipt already exists'));
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
      },
      runId: 'wrun_active_abort',
      specVersion: SPEC_VERSION_CURRENT,
      token: 'abrt_active_abort',
    } satisfies Hook;

    setWorld({
      events: { create: event },
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
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
    expect(write).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(queue).toHaveBeenCalledTimes(2);
    setWorld(undefined);
  });
});
