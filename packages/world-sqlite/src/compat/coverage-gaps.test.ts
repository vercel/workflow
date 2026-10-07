import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeSnapshotEnvelope, eventIdToSlot } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { encode } from '../db.js';
import { dbFor } from './db-cache.js';
import { createSnapshotsStorage } from './storage/snapshots-storage.js';
import { createStorage } from './storage.js';
import { createHook, createRun, updateRun } from './test-helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-coverage-gaps-'));
});
afterEach(async () => {
  dbFor(dir).close();
  await fs.rm(dir, { recursive: true, force: true });
});

it('keeps a ULID-numbered run on ULIDs with stable replay cursors', async () => {
  const storage = createStorage(dir);
  const run = await createRun(storage, {
    deploymentId: 'dpl_test',
    workflowName: 'ulid-continuation',
    input: new Uint8Array(),
  });
  await updateRun(storage, run.runId, 'run_started');
  const initial = await storage.events.list({ runId: run.runId });
  const ulid = monotonicFactory();
  const legacyIds = initial.data.map(() => `evnt_${ulid()}`);
  const db = dbFor(dir);
  // Simulate an existing pre-slot log, preserving each row's replay position.
  db.transaction(() => {
    initial.data.forEach((event, i) => {
      db.run(
        'UPDATE events SET event_id = ?, data = ? WHERE run_id = ? AND event_id = ? AND tag = ?',
        legacyIds[i],
        encode({ ...event, eventId: legacyIds[i] }),
        run.runId,
        event.eventId,
        ''
      );
    });
  });
  const appended = [];
  for (let i = 0; i < 3; i++) {
    const result = await createStorage(dir).events.create(run.runId, {
      eventType: 'step_created',
      correlationId: `step_after_upgrade_${i}`,
      eventData: {
        stepName: 'afterUpgrade',
        input: new Uint8Array([i]),
      },
    });
    appended.push(result.event.eventId);
  }
  const expectedIds = [...legacyIds, ...appended];
  expect(expectedIds).toHaveLength(5);
  expect(new Set(expectedIds).size).toBe(expectedIds.length);
  expect(expectedIds.map(eventIdToSlot)).toEqual(expectedIds.map(() => null));
  expect(
    expectedIds.every((id) => /^evnt_[0-9A-HJKMNP-TV-Z]{26}$/.test(id))
  ).toBe(true);
  const fresh = createStorage(dir);
  expect(
    (
      await fresh.events.list({ runId: run.runId, pagination: { limit: 100 } })
    ).data.map((event) => event.eventId)
  ).toEqual(expectedIds);
  const walked: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < expectedIds.length + 1; page++) {
    const result = await fresh.events.list({
      runId: run.runId,
      pagination: { limit: 1, cursor, sortOrder: 'asc' },
    });
    walked.push(...result.data.map((event) => event.eventId));
    if (!result.hasMore) break;
    expect(result.cursor).toBeTruthy();
    expect(cursors.has(result.cursor as string)).toBe(false);
    cursors.add(result.cursor as string);
    cursor = result.cursor as string;
  }
  expect(walked).toEqual(expectedIds);
  expect(
    (
      await fresh.events.list({
        runId: run.runId,
        pagination: { limit: 100, sortOrder: 'desc' },
      })
    ).data.map((event) => event.eventId)
  ).toEqual([...expectedIds].reverse());
});

it('treats malformed snapshot envelope BLOBs as cache misses', async () => {
  const snapshots = createSnapshotsStorage(dir);
  const db = dbFor(dir);
  const metadata = { eventsCursor: 'evnt_snapshot', createdAt: new Date() };
  const valid = encodeSnapshotEnvelope(metadata, new Uint8Array([7, 8]));
  const invalidVersion = valid.slice();
  invalidVersion[4] = 255;
  for (const corrupt of [
    new Uint8Array(),
    new Uint8Array([1, 2, 3]),
    new Uint8Array(64).fill(0xab),
    valid.subarray(0, 12),
    invalidVersion,
  ]) {
    db.run(
      'INSERT INTO snapshots (run_id, data) VALUES (?, ?) ON CONFLICT (run_id) DO UPDATE SET data = excluded.data',
      'wrun_corrupt_snapshot',
      corrupt
    );
    await expect(snapshots.load('wrun_corrupt_snapshot')).resolves.toBeNull();
  }
  // A malformed cached snapshot must not poison a subsequent valid save.
  await snapshots.save(
    'wrun_corrupt_snapshot',
    new Uint8Array([7, 8]),
    metadata
  );
  await expect(snapshots.load('wrun_corrupt_snapshot')).resolves.toEqual({
    data: new Uint8Array([7, 8]),
    metadata,
  });
});

it('removes legacy hooks and releases their tokens on cancellation', async () => {
  const storage = createStorage(dir);
  const db = dbFor(dir);
  const runId = 'wrun_legacy_cleanup';
  const hookId = 'hook_legacy_cleanup';
  const token = 'legacy-cleanup-token';
  const now = new Date();
  const run = {
    runId,
    deploymentId: 'dpl_test',
    workflowName: 'legacy-cleanup',
    specVersion: 1,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    input: new Uint8Array(),
  };
  const hook = {
    hookId,
    runId,
    token,
    createdAt: now,
    isWebhook: true,
    ownerId: 'test-owner',
    projectId: 'test-project',
    environment: 'test',
  };
  db.transaction(() => {
    db.run(
      'INSERT INTO runs (run_id, tag, status, workflow_name, created_at, data) VALUES (?, ?, ?, ?, ?, ?)',
      runId,
      '',
      run.status,
      run.workflowName,
      now.getTime(),
      encode(run)
    );
    db.run(
      'INSERT INTO hooks (hook_id, tag, run_id, token, created_at, data) VALUES (?, ?, ?, ?, ?, ?)',
      hookId,
      '',
      runId,
      token,
      now.getTime(),
      encode(hook)
    );
    db.run(
      'INSERT INTO hook_tokens (token, run_id, hook_id, event_id, data) VALUES (?, ?, ?, ?, ?)',
      token,
      runId,
      hookId,
      'evnt_legacy_claim',
      encode({ token, runId, hookId, eventId: 'evnt_legacy_claim' })
    );
  });
  await expect(storage.hooks.get(hookId)).resolves.toMatchObject(hook);
  await expect(storage.hooks.getByToken(token)).resolves.toMatchObject(hook);
  await storage.events.create(runId, { eventType: 'run_cancelled' });
  await expect(storage.runs.get(runId)).resolves.toMatchObject({
    status: 'cancelled',
  });
  await expect(storage.hooks.get(hookId)).rejects.toMatchObject({
    name: 'HookNotFoundError',
  });
  await expect(storage.hooks.getByToken(token)).rejects.toMatchObject({
    name: 'HookNotFoundError',
  });
  // Unavailability alone is insufficient: terminal filtering could hide rows
  // without actually removing the hook or releasing its constraint.
  expect(
    db.get(
      'SELECT hook_id FROM hooks WHERE hook_id = ? AND tag = ?',
      hookId,
      ''
    )
  ).toBeUndefined();
  expect(
    db.get('SELECT token FROM hook_tokens WHERE token = ?', token)
  ).toBeUndefined();
  const next = await createRun(storage, {
    deploymentId: 'dpl_test',
    workflowName: 'token-reuse',
    input: new Uint8Array(),
  });
  const successor = await createHook(storage, next.runId, {
    hookId: 'hook_successor',
    token,
  });
  await expect(createStorage(dir).hooks.getByToken(token)).resolves.toEqual(
    successor
  );
});
