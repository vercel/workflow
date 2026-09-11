import { describe, expect, it } from 'vitest';
import { createWorld } from './index.js';

describe('createWorld capabilities', () => {
  it('declares that Vercel Queues redelivers unacked messages', () => {
    // The runtime's queue-owned backstop fails closed on this declaration:
    // without it a replay re-sends every queue-owned running step's message.
    const world = createWorld({ token: 'test-token' });
    expect(world.capabilities?.queueRedeliversUnacked).toEqual({
      active: true,
    });
  });

  it('keeps hook retention and deployment affinity declared', () => {
    const world = createWorld({ token: 'test-token' });
    expect(world.capabilities?.hookRetention).toEqual({ active: true });
    expect(world.capabilities?.deploymentAffinity).toBe(true);
  });
});
