import { waitForHook } from '@workflow/vitest';
import { afterAll, describe, expect, it } from 'vitest';
import { getHookByToken, getRun, start } from 'workflow/api';
import {
  getOrStart,
  sendToSingleton,
  singletonToken,
  userSession,
} from '../workflows/patterns/singleton-run.js';

// The local world persists across vitest invocations — singletons from a
// previous run can still be alive. Unique keys per run keep tests hermetic.
const RUN = Date.now().toString(36);

describe('singleton-run', () => {
  const startedRunIds: string[] = [];

  afterAll(async () => {
    // Don't leak live mailbox loops into the next suite.
    for (const runId of startedRunIds) {
      await getRun(runId)
        .cancel()
        .catch(() => {});
    }
  });

  it('getOrStart dedupes and the mailbox processes messages in order', async () => {
    const userId = `dedupe-${RUN}`;
    const key = `user-session:${userId}`;

    const first = await getOrStart(key, () => start(userSession, [userId]));
    startedRunIds.push(first.runId);
    expect(first.started).toBe(true);

    // Wait until the run's first act (mailbox registration) lands so the
    // second probe deterministically finds the live run.
    await waitForHook(getRun(first.runId), { token: singletonToken(key) });

    const second = await getOrStart(key, () => start(userSession, [userId]));
    expect(second).toEqual({ runId: first.runId, started: false });

    await sendToSingleton(key, { type: 'task', payload: 'a' });
    await sendToSingleton(key, { type: 'task', payload: 'b' });
    await sendToSingleton(key, { type: 'task', payload: 'c' });
    await sendToSingleton(key, { type: 'stop' });

    const result = await getRun(first.runId).returnValue;
    expect(result).toEqual({ userId, processed: 3 });
  });

  it('concurrent getOrStart race leaves exactly one surviving run', async () => {
    const userId = `race-${RUN}`;
    const key = `user-session:${userId}`;
    const token = singletonToken(key);

    const [a, b] = await Promise.all([
      getOrStart(key, () => start(userSession, [userId])),
      getOrStart(key, () => start(userSession, [userId])),
    ]);
    startedRunIds.push(a.runId, b.runId);

    // Whoever registers the mailbox owns the singleton slot.
    let owner: { runId: string } | null = null;
    const deadline = Date.now() + 15_000;
    while (!owner && Date.now() < deadline) {
      owner = await getHookByToken(token).catch(() => null);
      if (!owner) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!owner) {
      throw new Error('no run registered the singleton mailbox within 15s');
    }
    const ownerRunId = owner.runId;
    expect([a.runId, b.runId]).toContain(ownerRunId);

    // Invariant (covers both race outcomes): every started run that is NOT
    // the hook owner must exit cleanly with { dedupedTo: ownerRunId }. When
    // the probes raced past each other we get one such loser; if a probe
    // saw the winner's hook first, dedupe already happened sequentially
    // (same runId, started:false) and there are no losers.
    const losers = [a, b].filter(
      (candidate) => candidate.started && candidate.runId !== ownerRunId
    );
    for (const loser of losers) {
      const value = await getRun(loser.runId).returnValue;
      expect(value).toEqual({ userId, dedupedTo: ownerRunId });
    }

    // The surviving run is still serviceable: feed it and stop it.
    await sendToSingleton(key, { type: 'task', payload: 'after-race' });
    await sendToSingleton(key, { type: 'stop' });
    const result = await getRun(ownerRunId).returnValue;
    expect(result).toEqual({ userId, processed: 1 });
  });
});
