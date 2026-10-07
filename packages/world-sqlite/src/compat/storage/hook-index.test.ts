import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Storage } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHook,
  createRun,
  disposeHook,
  updateRun,
} from '../test-helpers.js';
import { createStorage } from './index.js';

describe('hook indexes', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-index-test-'));
    storage = createStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function newRun(): Promise<string> {
    const run = await createRun(storage, {
      deploymentId: 'dpl_test',
      workflowName: 'test-workflow',
      input: new Uint8Array(),
    });
    return run.runId;
  }

  // world-sqlite: filesystem index-rebuild utilities are not applicable.
  it('cleans up only the terminal run’s hooks via by-run markers', async () => {
    const runA = await newRun();
    const runB = await newRun();
    await createHook(storage, runA, { hookId: 'hook_a1', token: 'token-a1' });
    await createHook(storage, runA, { hookId: 'hook_a2', token: 'token-a2' });
    await createHook(storage, runB, { hookId: 'hook_b1', token: 'token-b1' });

    await updateRun(storage, runA, 'run_completed', { output: undefined });

    // Run A's hooks (entities + markers + claims) are gone…
    await expect(storage.hooks.get('hook_a1')).rejects.toThrow();
    await expect(storage.hooks.get('hook_a2')).rejects.toThrow();
    // world-sqlite: retain API cleanup and token-reuse assertions, not marker files.
    // …and their tokens are reusable by other runs.
    const reuse = await storage.events.create(runB, {
      eventType: 'hook_created',
      correlationId: 'hook_b_reuse',
      eventData: { token: 'token-a1' },
    });
    expect(reuse.event.eventType).toBe('hook_created');

    // Run B's hook is untouched.
    await expect(storage.hooks.get('hook_b1')).resolves.toMatchObject({
      runId: runB,
      hookId: 'hook_b1',
    });
  });

  it('resolves hooks by token through the claim-file fast path', async () => {
    const runId = await newRun();
    await createHook(storage, runId, {
      hookId: 'hook_fast_path',
      token: 'fast-path-token',
    });

    await expect(
      storage.hooks.getByToken('fast-path-token')
    ).resolves.toMatchObject({
      hookId: 'hook_fast_path',
      token: 'fast-path-token',
    });
  });

  // world-sqlite: filesystem layout/claim/cache mechanics have no SQLite equivalent.

  // world-sqlite: filesystem scan-performance tests do not apply.
});
