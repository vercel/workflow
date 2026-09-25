import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { publishForceClaimVictimWake } from './hook-wake.js';

vi.mock('../logger.js', () => ({
  runtimeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function worldWithQueue(queue: World['queue']): World {
  return { queue } as unknown as World;
}

describe('publishForceClaimVictimWake', () => {
  const hook = {
    hookId: 'hook_claimer',
    claimedFrom: {
      runId: 'wrun_victim',
      hookId: 'hook_victim',
      workflowName: 'victimWorkflow',
      deploymentId: 'dpl_victim',
      runSpecVersion: SPEC_VERSION_CURRENT,
    },
  };

  it("publishes a plain invoke to the victim's queue, on its deployment, keyed by the claimer's hook", async () => {
    const queue = vi.fn().mockResolvedValue(undefined);
    const outcome = await publishForceClaimVictimWake(
      worldWithQueue(queue),
      'wrun_claimer',
      hook
    );
    expect(outcome).toBe('published');
    expect(queue).toHaveBeenCalledTimes(1);
    const [queueName, message, options] = queue.mock.calls[0];
    expect(queueName).toContain('victimWorkflow');
    expect(message).toEqual({ runId: 'wrun_victim' });
    expect(options).toMatchObject({
      deploymentId: 'dpl_victim',
      specVersion: SPEC_VERSION_CURRENT,
      idempotencyKey: 'hook-force-claim-hook_claimer',
    });
  });

  it('skips a hook that took nothing over, and a run taking over its own hook', async () => {
    const queue = vi.fn();
    expect(
      await publishForceClaimVictimWake(worldWithQueue(queue), 'wrun_x', {
        hookId: 'hook_x',
      })
    ).toBe('skipped');
    expect(
      await publishForceClaimVictimWake(
        worldWithQueue(queue),
        'wrun_victim',
        hook
      )
    ).toBe('skipped');
    expect(queue).not.toHaveBeenCalled();
  });

  it('retries a transport-shaped failure, then reports failure without throwing', async () => {
    const transient = Object.assign(new Error('boom'), { status: 503 });
    const queue = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(undefined);
    expect(
      await publishForceClaimVictimWake(
        worldWithQueue(queue),
        'wrun_claimer',
        hook
      )
    ).toBe('published');
    expect(queue).toHaveBeenCalledTimes(2);

    const always = vi.fn().mockRejectedValue(transient);
    expect(
      await publishForceClaimVictimWake(
        worldWithQueue(always),
        'wrun_claimer',
        hook
      )
    ).toBe('failed');
    // Initial attempt + two retries.
    expect(always).toHaveBeenCalledTimes(3);
  });

  it('does not retry a definitive rejection', async () => {
    const definitive = Object.assign(new Error('nope'), {
      name: 'BadRequestError',
    });
    const queue = vi.fn().mockRejectedValue(definitive);
    expect(
      await publishForceClaimVictimWake(
        worldWithQueue(queue),
        'wrun_claimer',
        hook
      )
    ).toBe('failed');
    expect(queue).toHaveBeenCalledTimes(1);
  });
});
