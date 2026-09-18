/**
 * `createHook({ experimental_force: true })` on the local World, under the
 * race the design has to survive: several runs forcing the same token at
 * once. Whatever the interleaving, exactly one run ends up owning the token,
 * every other run's log carries the `hook_disposed{forceClaimedBy}` its
 * replay reads, and no `hook_created` ever lands behind its own disposal
 * (the ordering workflow-server guards with a ConditionCheck on the run's own
 * marker, and postgres by journaling inside the takeover transaction).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
  type Storage,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHook, createRun, updateRun } from '../test-helpers.js';
import { createStorage } from './index.js';

describe('local World hook force-claim', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-force-claim-'));
    storage = createStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function runningRun(
    workflowName: string,
    specVersion: number = SPEC_VERSION_CURRENT
  ): Promise<string> {
    const { run } = await storage.events.create(null, {
      eventType: 'run_created',
      specVersion,
      eventData: {
        deploymentId: `dpl_${workflowName}`,
        workflowName,
        input: new Uint8Array(),
      },
    });
    const runId = run!.runId;
    await storage.events.create(runId, {
      eventType: 'run_started',
      specVersion,
    });
    return runId;
  }

  const eventTypes = async (runId: string) =>
    (await storage.events.list({ runId, pagination: {} })).data.map(
      (e) => e.eventType
    );

  it('three claimers forcing the same token at once converge on one owner, each loser told', async () => {
    const token = 'channel:race';
    const victim = await runningRun('victim');
    await createHook(storage, victim, { hookId: 'hook_victim', token });
    const claimers = await Promise.all(
      [1, 2, 3].map((n) => runningRun(`claimer-${n}`))
    );

    const results = await Promise.all(
      claimers.map((runId, i) =>
        storage.events.create(runId, {
          eventType: 'hook_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: `hook_claimer_${i + 1}`,
          eventData: { token, force: true },
        })
      )
    );
    for (const result of results) {
      expect(result.event.eventType).toBe('hook_created');
    }

    const owner = await storage.hooks.getByToken(token);
    expect(claimers).toContain(owner.runId);
    expect(owner.claimedFrom).toBeDefined();

    // The victim lost the token to one of the claimers.
    const victimLog = (
      await storage.events.list({ runId: victim, pagination: {} })
    ).data;
    const victimDisposal = victimLog.find(
      (e) => e.eventType === 'hook_disposed'
    );
    expect(claimers).toContain(
      (victimDisposal?.eventData as { forceClaimedBy: { runId: string } })
        .forceClaimedBy.runId
    );

    // Every claimer that did not end up owning the token has a disposal in
    // its log AFTER its creation — never before it — naming a run that did
    // hold the token after it.
    for (const runId of claimers.filter((r) => r !== owner.runId)) {
      const types = await eventTypes(runId);
      expect(types).toEqual([
        'run_created',
        'run_started',
        'hook_created',
        'hook_disposed',
      ]);
    }
    // The owner's log ends in its creation.
    expect(await eventTypes(owner.runId)).toEqual([
      'run_created',
      'run_started',
      'hook_created',
    ]);
  });

  it('declines to take a token from a running victim below the force-claim spec version', async () => {
    // A run stamped one version below SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM:
    // its runtime would take `hook_disposed{forceClaimedBy}` for its own
    // `dispose()` and hang on `await hook`, so the World writes nothing and
    // answers the ordinary conflict, marked as declined on purpose.
    const token = 'channel:legacy';
    const victim = await runningRun(
      'legacy-victim',
      SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM - 1
    );
    // Retained, so the token stays with the finished victim below.
    const victimHook = await createHook(storage, victim, {
      hookId: 'hook_legacy_victim',
      token,
      tokenRetentionUntil: new Date(Date.now() + 60 * 60 * 1000),
    });
    const claimer = await runningRun('claimer');

    const result = await storage.events.create(claimer, {
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook_claimer',
      eventData: { token, force: true },
    });
    expect(result.event.eventType).toBe('hook_conflict');
    expect(result.event.eventData).toMatchObject({
      token,
      conflictingRunId: victim,
      forceRefusedReason: 'victim-spec-version',
    });
    expect(result.hook).toBeUndefined();
    expect(await eventTypes(victim)).toEqual([
      'run_created',
      'run_started',
      'hook_created',
    ]);
    expect((await storage.hooks.getByToken(token)).hookId).toBe(
      victimHook.hookId
    );

    // A finished victim has no reader to strand: the same create takes its
    // retained token at any version.
    await updateRun(storage, victim, 'run_completed', {
      result: new Uint8Array(),
    });
    const retaken = await storage.events.create(claimer, {
      eventType: 'hook_created',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: 'hook_claimer_again',
      eventData: { token, force: true },
    });
    expect(retaken.event.eventType).toBe('hook_created');
    expect(retaken.hook?.claimedFrom).toEqual({
      runId: victim,
      hookId: victimHook.hookId,
    });
  });
});
