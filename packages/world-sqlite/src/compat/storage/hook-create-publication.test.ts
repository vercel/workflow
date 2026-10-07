import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createRun } from '../test-helpers.js';
import { createStorage } from './index.js';

// world-sqlite: transactions replace claim-adoption gates; retain their publication guarantees.
it('publishes unrelated hook creations once each', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-publication-'));
  try {
    const storage = createStorage(dir);
    const run = await createRun(storage, {
      deploymentId: 'dpl_test',
      workflowName: 'test',
      input: new Uint8Array(),
    });
    await Promise.all(
      ['first', 'other'].map((id) =>
        createStorage(dir).events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: `hook_${id}`,
          eventData: { token: `token_${id}` },
        })
      )
    );
    const { data } = await storage.events.list({ runId: run.runId });
    expect(
      data
        .filter((e) => e.eventType === 'hook_created')
        .map((e) => e.correlationId)
    ).toEqual(['hook_first', 'hook_other']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('does not republish when a hook claim adopter wins the event slot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-publication-'));
  try {
    const storage = createStorage(dir);
    const run = await createRun(storage, {
      deploymentId: 'dpl_test',
      workflowName: 'test',
      input: new Uint8Array(),
    });
    // Separate connections contend for the same hook and token. Different
    // metadata detects a loser overwriting the winner's materialized hook.
    const width = 12;
    const results = await Promise.allSettled(
      Array.from({ length: width }, (_, publisher) =>
        createStorage(dir).events.create(run.runId, {
          eventType: 'hook_created',
          correlationId: 'hook_race',
          eventData: { token: 'token_race', metadata: { publisher } },
        })
      )
    );
    const winners = results.filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const losers = results.filter((r) => r.status === 'rejected');
    expect(losers).toHaveLength(width - 1);
    for (const loser of losers) {
      expect(loser.reason).toMatchObject({ name: 'EntityConflictError' });
    }
    if (winners[0]?.status !== 'fulfilled') throw new Error('No winner');
    const winner = winners[0].value;
    const metadata = {
      publisher: results.findIndex((r) => r.status === 'fulfilled'),
    };
    expect(winner.event).toMatchObject({
      eventType: 'hook_created',
      correlationId: 'hook_race',
      eventData: { token: 'token_race', metadata },
    });
    expect(winner.hook).toMatchObject({
      hookId: 'hook_race',
      token: 'token_race',
      runId: run.runId,
      metadata,
    });
    for (let reread = 0; reread < 3; reread++) {
      const fresh = createStorage(dir);
      const { data } = await fresh.events.list({
        runId: run.runId,
        pagination: { limit: 1000 },
      });
      expect(data.filter((e) => e.eventType === 'hook_created')).toEqual([
        winner.event,
      ]);
      expect(data.filter((e) => e.eventType === 'hook_conflict')).toEqual([]);
      expect(await fresh.hooks.get('hook_race')).toEqual(winner.hook);
      expect(await fresh.hooks.getByToken('token_race')).toEqual(winner.hook);
    }
    // A stable token claim must also reject a different hook, without
    // replacing the published owner's hook or token lookup.
    const conflict = await createStorage(dir).events.create(run.runId, {
      eventType: 'hook_created',
      correlationId: 'hook_other_claimant',
      eventData: { token: 'token_race' },
    });
    expect(conflict.event).toMatchObject({
      eventType: 'hook_conflict',
      correlationId: 'hook_other_claimant',
      eventData: { token: 'token_race', conflictingRunId: run.runId },
    });
    expect(conflict.hook).toBeUndefined();
    await expect(
      storage.hooks.get('hook_other_claimant')
    ).rejects.toMatchObject({
      name: 'HookNotFoundError',
    });
    expect(await storage.hooks.getByToken('token_race')).toEqual(winner.hook);
    await expect(
      createStorage(dir).events.create(run.runId, {
        eventType: 'hook_created',
        correlationId: 'hook_race',
        eventData: { token: 'token_race', metadata: { publisher: 'retry' } },
      })
    ).rejects.toMatchObject({ name: 'EntityConflictError' });
    expect(await storage.hooks.get('hook_race')).toEqual(winner.hook);
    const final = await storage.events.list({ runId: run.runId });
    expect(final.data.filter((e) => e.eventType === 'hook_created')).toEqual([
      winner.event,
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
