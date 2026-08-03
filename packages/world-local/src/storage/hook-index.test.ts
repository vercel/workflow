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
import { hashToken } from './helpers.js';
import { resetHookIndexEnsureCache } from './hook-index.js';
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

  async function listDirSafe(...segments: string[]): Promise<string[]> {
    try {
      return await fs.readdir(path.join(testDir, ...segments));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Remove all index state, as if created by a pre-index version. */
  async function simulateLegacyDataDir(): Promise<void> {
    await fs.rm(path.join(testDir, 'hooks', 'token-index'), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(testDir, 'hooks', 'id-index'), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(testDir, 'hooks', 'by-run'), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(testDir, 'hooks', '.hook-index-complete'), {
      force: true,
    });
    resetHookIndexEnsureCache();
  }

  it('maintains token-, id- and by-run indexes on hook creation', async () => {
    const runId = await newRun();
    const created = await storage.events.create(runId, {
      eventType: 'hook_created',
      correlationId: 'hook_indexed',
      eventData: { token: 'indexed-token' },
    });
    expect(created.event.eventType).toBe('hook_created');

    const tokenEntries = await listDirSafe(
      'hooks',
      'token-index',
      hashToken('indexed-token')
    );
    expect(tokenEntries).toEqual([`${created.event.eventId}.json`]);

    const idEntries = await listDirSafe('hooks', 'id-index', 'hook_indexed');
    expect(idEntries).toEqual([`${created.event.eventId}.json`]);

    const byRunMarkers = await listDirSafe('hooks', 'by-run');
    expect(byRunMarkers).toEqual([`${runId}-hook_indexed.json`]);
  });

  it('reaps the by-run marker when a hook is disposed', async () => {
    const runId = await newRun();
    await createHook(storage, runId, {
      hookId: 'hook_disposed_marker',
      token: 'disposed-marker-token',
    });
    expect(await listDirSafe('hooks', 'by-run')).toHaveLength(1);

    await disposeHook(storage, runId, 'hook_disposed_marker');
    expect(await listDirSafe('hooks', 'by-run')).toHaveLength(0);
  });

  it('detects token conflicts via the index after the claim file is lost', async () => {
    const runId = await newRun();
    const otherRunId = await newRun();
    await createHook(storage, runId, {
      hookId: 'hook_lost_claim',
      token: 'lost-claim-token',
    });

    // Simulate a crash-lost token cache: claim file and entity gone,
    // but the hook_created event is committed in the log.
    await fs.unlink(
      path.join(
        testDir,
        'hooks',
        'tokens',
        `${hashToken('lost-claim-token')}.json`
      )
    );
    await fs.unlink(path.join(testDir, 'hooks', 'hook_lost_claim.json'));

    const conflict = await storage.events.create(otherRunId, {
      eventType: 'hook_created',
      correlationId: 'hook_lost_claim_other',
      eventData: { token: 'lost-claim-token' },
    });
    expect(conflict.event.eventType).toBe('hook_conflict');
    expect((conflict.event as any).eventData.conflictingRunId).toBe(runId);
  });

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
    expect(await listDirSafe('hooks', 'by-run')).toEqual([
      `${runB}-hook_b1.json`,
    ]);
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

  describe('legacy data directories (pre-index backfill)', () => {
    it('rebuilds hook caches from the event log after backfill', async () => {
      const runId = await newRun();
      const created = await storage.events.create(runId, {
        eventType: 'hook_created',
        correlationId: 'hook_legacy_rebuild',
        eventData: { token: 'legacy-rebuild-token' },
      });
      expect(created.event.eventType).toBe('hook_created');

      await simulateLegacyDataDir();
      await fs.unlink(
        path.join(
          testDir,
          'hooks',
          'tokens',
          `${hashToken('legacy-rebuild-token')}.json`
        )
      );
      await fs.unlink(path.join(testDir, 'hooks', 'hook_legacy_rebuild.json'));

      // hooks.get triggers the backfill, then rebuilds entity + claim.
      await expect(
        storage.hooks.get('hook_legacy_rebuild')
      ).resolves.toMatchObject({
        runId,
        hookId: 'hook_legacy_rebuild',
        token: 'legacy-rebuild-token',
      });

      // The backfill published its completion marker.
      const markerExists = await fs
        .access(path.join(testDir, 'hooks', '.hook-index-complete'))
        .then(() => true)
        .catch(() => false);
      expect(markerExists).toBe(true);
    });

    it('still detects token conflicts for hooks created pre-index', async () => {
      const runId = await newRun();
      const otherRunId = await newRun();
      await createHook(storage, runId, {
        hookId: 'hook_legacy_conflict',
        token: 'legacy-conflict-token',
      });

      await simulateLegacyDataDir();
      await fs.unlink(
        path.join(
          testDir,
          'hooks',
          'tokens',
          `${hashToken('legacy-conflict-token')}.json`
        )
      );

      const conflict = await storage.events.create(otherRunId, {
        eventType: 'hook_created',
        correlationId: 'hook_legacy_conflict_other',
        eventData: { token: 'legacy-conflict-token' },
      });
      expect(conflict.event.eventType).toBe('hook_conflict');
      expect((conflict.event as any).eventData.conflictingRunId).toBe(runId);
    });

    it('cleans up pre-index hooks on run termination via backfilled markers', async () => {
      const runId = await newRun();
      await createHook(storage, runId, {
        hookId: 'hook_legacy_cleanup',
        token: 'legacy-cleanup-token',
      });

      await simulateLegacyDataDir();

      await updateRun(storage, runId, 'run_completed', { output: undefined });

      await expect(storage.hooks.get('hook_legacy_cleanup')).rejects.toThrow();
      // Claim released: the token is reusable.
      const otherRunId = await newRun();
      const reuse = await storage.events.create(otherRunId, {
        eventType: 'hook_created',
        correlationId: 'hook_legacy_cleanup_reuse',
        eventData: { token: 'legacy-cleanup-token' },
      });
      expect(reuse.event.eventType).toBe('hook_created');
    });
  });

  describe('performance', () => {
    it(
      'hook creation cost does not scale with unrelated event history',
      { timeout: 120_000 },
      async () => {
        const runId = await newRun();
        const HOOKS = 10;
        const TRIALS = 5;

        // Median of several trials, not a single sample: a lone slow trial
        // (e.g. a Windows CI runner's antivirus briefly locking a just-
        // written file — the reason `write()` in fs.ts retries EPERM/EBUSY)
        // would otherwise swing a single-sample measurement by itself, in
        // either direction, and produce a flaky pass or fail.
        async function timeHookCreations(prefix: string): Promise<number> {
          const trialTimes: number[] = [];
          for (let trial = 0; trial < TRIALS; trial++) {
            const start = performance.now();
            for (let i = 0; i < HOOKS; i++) {
              await createHook(storage, runId, {
                hookId: `hook_${prefix}_${trial}_${i}`,
                token: `${prefix}-token-${trial}-${i}`,
              });
            }
            trialTimes.push(performance.now() - start);
          }
          trialTimes.sort((a, b) => a - b);
          return trialTimes[Math.floor(trialTimes.length / 2)];
        }

        // Baseline on an empty history (also completes the backfill).
        const baselineMs = await timeHookCreations('baseline');

        // Seed a large foreign event history that the indexed hook
        // paths must never read.
        const eventsDir = path.join(testDir, 'events');
        const seededRun = 'wrun_01SEEDED0000000000000000000';
        const seedCount = 1000;
        const seedConcurrency = 50;
        for (let start = 0; start < seedCount; start += seedConcurrency) {
          await Promise.all(
            Array.from(
              { length: Math.min(seedConcurrency, seedCount - start) },
              (_, i) => {
                const n = start + i;
                return fs.writeFile(
                  path.join(
                    eventsDir,
                    `${seededRun}-evnt_${String(n).padStart(26, '0')}.json`
                  ),
                  JSON.stringify({
                    runId: seededRun,
                    eventId: `evnt_${String(n).padStart(26, '0')}`,
                    eventType: 'step_started',
                    correlationId: `step_${n}`,
                    createdAt: new Date().toISOString(),
                    specVersion: 2,
                  })
                );
              }
            )
          );
        }

        const seededMs = await timeHookCreations('seeded');

        // Machine-speed independent: the pre-index implementation read
        // every seeded event per creation (~10k reads here), inflating
        // the seeded measurement by orders of magnitude relative to the
        // baseline. The generous ratio + constant absorbs fs jitter on
        // slow CI runners (notably Windows).
        expect(seededMs).toBeLessThan(baselineMs * 5 + 1000);
      }
    );
  });
});
