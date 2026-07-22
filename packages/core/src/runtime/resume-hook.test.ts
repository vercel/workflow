import { HookNotFoundError } from '@workflow/errors';
import {
  type Hook,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeHook } from './resume-hook.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  linkToTraceCarrier: vi.fn(),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));

describe('resumeHook', () => {
  afterEach(() => setWorld(undefined));

  it('rejects a retained Hook after its run ends', async () => {
    const hook = {
      runId: 'wrun_1',
      hookId: 'hook_1',
      token: 'order:1',
      ownerId: 'owner_1',
      projectId: 'project_1',
      environment: 'production',
      createdAt: new Date(),
    } satisfies Hook;
    const run = {
      runId: hook.runId,
      status: 'completed',
      deploymentId: 'deployment_1',
      workflowName: 'processOrder',
      output: undefined,
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      attributes: {},
    } satisfies WorkflowRun;
    const createEvent = vi.fn();
    const getEncryptionKeyForRun = vi.fn();
    const queue = vi.fn();

    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      hooks: { getByToken: vi.fn().mockResolvedValue(hook) },
      runs: { get: vi.fn().mockResolvedValue(run) },
      events: { create: createEvent },
      getEncryptionKeyForRun,
      queue,
    } as unknown as World);

    await expect(resumeHook(hook.token, {})).rejects.toSatisfy(
      HookNotFoundError.is
    );
    expect(createEvent).not.toHaveBeenCalled();
    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });
});
