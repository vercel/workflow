import { describe, expect, it, vi } from 'vitest';

const sqliteState = vi.hoisted(() => ({ loads: 0 }));

vi.mock('node:sqlite', () => {
  sqliteState.loads += 1;
  throw new Error('simulated unsupported node:sqlite runtime');
});

describe('web server actions on Node runtimes without node:sqlite', () => {
  it('remain loadable for non-SQLite Worlds', async () => {
    const actions = await import('./workflow-server-actions.server.js');

    expect(actions.fetchRuns).toBeTypeOf('function');
    expect(sqliteState.loads).toBe(0);
  });
});
