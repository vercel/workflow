import { describe, expect, it, vi } from 'vitest';

const sqliteState = vi.hoisted(() => ({ loads: 0 }));

vi.mock('node:sqlite', () => {
  sqliteState.loads += 1;
  throw new Error('simulated unsupported node:sqlite runtime');
});

describe('inspect setup on Node runtimes without node:sqlite', () => {
  it('remains loadable for non-SQLite Worlds', async () => {
    const setup = await import('./setup.js');

    expect(setup.setupCliWorld).toBeTypeOf('function');
    expect(sqliteState.loads).toBe(0);
  });
});
