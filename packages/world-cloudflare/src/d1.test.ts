import { describe, expect, it, vi } from 'vitest';
import {
  deleteHookIndex,
  deleteHooksForRunIndex,
  insertHookIndex,
  upsertRunIndex,
} from './d1.js';

function createMockDb() {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  const exec = vi.fn().mockResolvedValue({ success: true });
  return { prepare, exec, run, bind } as unknown as D1Database & {
    run: ReturnType<typeof vi.fn>;
    bind: ReturnType<typeof vi.fn>;
  };
}

describe('d1 index helpers', () => {
  it('upserts a run index row', async () => {
    const db = createMockDb();
    await upsertRunIndex(db, {
      runId: 'wrun_01ABC',
      workflowName: 'my-workflow',
      status: 'running',
      deploymentId: 'cloudflare',
      specVersion: 2,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:01.000Z',
      startedAt: '2024-01-01T00:00:00.500Z',
    });
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO workflow_runs_index')
    );
  });

  it('inserts a hook index row', async () => {
    const db = createMockDb();
    await insertHookIndex(db, {
      hookId: 'hook_01ABC',
      runId: 'wrun_01ABC',
      token: 'tok_secret',
      ownerId: 'owner1',
      projectId: 'proj1',
      environment: 'production',
      createdAt: '2024-01-01T00:00:00.000Z',
      isWebhook: true,
      specVersion: 2,
    });
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO workflow_hooks_index')
    );
  });

  it('deletes a hook index row', async () => {
    const db = createMockDb();
    await deleteHookIndex(db, 'hook_01ABC');
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM workflow_hooks_index WHERE hook_id')
    );
  });

  it('deletes all hooks for a run from the index', async () => {
    const db = createMockDb();
    await deleteHooksForRunIndex(db, 'wrun_01ABC');
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM workflow_hooks_index WHERE run_id')
    );
  });
});
