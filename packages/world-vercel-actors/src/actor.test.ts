import type { World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { createActorHandler } from './actor.js';

function fixture() {
  const quarantine = vi.fn(async () => {});
  const world = {
    execution: { quarantine },
    createQueueHandler:
      (_prefix: string, callback: (payload: unknown) => Promise<void>) =>
      async (request: Request) => {
        await callback(await request.json());
        return new Response(null, { status: 204 });
      },
  } as unknown as World;
  return { world, quarantine };
}
const request = (runId: string, affinity?: string) =>
  new Request('http://local/cell', {
    method: 'POST',
    headers: affinity ? { 'x-test-affinity': affinity } : {},
    body: JSON.stringify({ runId }),
  });

describe('Vercel actor host boundary', () => {
  it('owns the run registry and shares one session across handler instances', async () => {
    const { world } = fixture();
    const receive = vi.fn(async () => {});
    const factory = vi.fn(() => ({ receive }));
    const first = createActorHandler(world, factory, () => 'x-test-affinity');
    const second = createActorHandler(world, factory, () => 'x-test-affinity');
    await Promise.all([
      first(request('run1', 'run1')),
      second(request('run1', 'run1')),
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('run1');
    expect(receive).toHaveBeenCalledTimes(2);
  });
  it('rejects missing headers before constructing a core session', async () => {
    const { world } = fixture();
    const factory = vi.fn();
    const handler = createActorHandler(world, factory, () => 'x-test-affinity');
    await expect(handler(request('run1'))).rejects.toThrow('missing');
    expect(factory).not.toHaveBeenCalled();
  });
  it('quarantines mismatched run affinity without entering core', async () => {
    const { world, quarantine } = fixture();
    const factory = vi.fn();
    const handler = createActorHandler(world, factory, () => 'x-test-affinity');
    await expect(handler(request('run1', 'run2'))).rejects.toThrow(
      'does not equal'
    );
    expect(quarantine).toHaveBeenCalledWith(
      'run1',
      expect.objectContaining({ code: 'EXECUTION_INVARIANT_VIOLATION' })
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it('does not replace a faulted session on redelivery', async () => {
    const { world } = fixture();
    const receive = vi.fn(async () => {
      throw new Error('faulted');
    });
    const factory = vi.fn(() => ({ receive }));
    const handler = createActorHandler(world, factory, () => 'x-test-affinity');
    await expect(handler(request('run1', 'run1'))).rejects.toThrow('faulted');
    await expect(handler(request('run1', 'run1'))).rejects.toThrow('faulted');
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
