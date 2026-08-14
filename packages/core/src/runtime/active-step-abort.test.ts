import { type Hook, SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';

import { resumeHook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));

describe('active-step abort resume', () => {
  it('writes the matching system abort packet before the hook resume can wait for a running step', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const event = vi.fn().mockImplementation(async () => {
      expect(write).toHaveBeenCalledOnce();
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
});
