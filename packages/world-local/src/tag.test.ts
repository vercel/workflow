import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseFor } from './db/index.js';
import { createWorld } from './index.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import {
  createHook,
  createRun,
  createStep,
  disposeHook,
  updateRun,
} from './test-helpers.js';

/**
 * Tags let several World instances share one data directory without seeing
 * each other's data: usually the app and the vitest test runner. A tagged
 * World writes rows with its tag, reads its own and untagged ones, and its
 * `clear()` deletes only its own.
 */
describe('tags', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-test-'));
  });

  afterEach(async () => {
    databaseFor(testDir).close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const newRun = (storage: Parameters<typeof createRun>[0], name = 'wf') =>
    createRun(storage, {
      deploymentId: 'dep-1',
      workflowName: name,
      input: new Uint8Array(),
    });

  const runTags = () =>
    databaseFor(testDir)
      .all<{ tag: string | null }>('SELECT tag FROM runs')
      .map((row) => row.tag);

  describe('reads', () => {
    it('writes rows with its tag and reads them back', async () => {
      const storage = createStorage(testDir, 'vitest-0');
      const run = await newRun(storage, 'tagged-wf');
      expect(runTags()).toEqual(['vitest-0']);
      expect((await storage.runs.get(run.runId)).workflowName).toBe(
        'tagged-wf'
      );
    });

    it('a tagged World also reads untagged runs', async () => {
      const run = await newRun(createStorage(testDir), 'untagged-wf');
      const tagged = createStorage(testDir, 'vitest-0');
      expect((await tagged.runs.get(run.runId)).workflowName).toBe(
        'untagged-wf'
      );
    });

    it("an untagged World and another tag do not read a tag's runs", async () => {
      const run = await newRun(createStorage(testDir, 'vitest-0'));
      await expect(
        createStorage(testDir).runs.get(run.runId)
      ).rejects.toThrow();
      await expect(
        createStorage(testDir, 'vitest-1').runs.get(run.runId)
      ).rejects.toThrow();
    });

    it('lists runs of every tag', async () => {
      await newRun(createStorage(testDir), 'untagged-wf');
      await newRun(createStorage(testDir, 'vitest-0'), 'tagged-wf');
      const { data } = await createStorage(testDir, 'vitest-0').runs.list();
      expect(data.map((run) => run.workflowName).sort()).toEqual([
        'tagged-wf',
        'untagged-wf',
      ]);
    });
  });

  describe('tagged clear()', () => {
    it("deletes only its own tag's runs, and everything they own", async () => {
      const untaggedWorld = createWorld({ dataDir: testDir });
      const taggedWorld = createWorld({ dataDir: testDir, tag: 'vitest-0' });
      const otherWorld = createWorld({ dataDir: testDir, tag: 'vitest-1' });

      const kept = await newRun(untaggedWorld, 'untagged-wf');
      const other = await newRun(otherWorld, 'other-wf');
      const cleared = await newRun(taggedWorld, 'tagged-wf');
      await updateRun(taggedWorld, cleared.runId, 'run_started');
      await createStep(taggedWorld, cleared.runId, {
        stepId: 'step_1',
        stepName: 'add',
        input: new Uint8Array(),
      });
      await createHook(taggedWorld, cleared.runId, {
        hookId: 'hook_tagged',
        token: 'tagged-token',
      });
      await taggedWorld.streams.write(cleared.runId, 'strm_tagged', 'chunk');

      await taggedWorld.clear();

      expect(runTags().sort()).toEqual(['vitest-1', null].sort());
      const db = databaseFor(testDir);
      for (const table of ['events', 'steps', 'hooks', 'stream_chunks']) {
        expect(
          db.all(`SELECT 1 FROM ${table} WHERE run_id = ?`, cleared.runId)
        ).toEqual([]);
      }
      expect(
        db.all('SELECT 1 FROM hook_tokens WHERE token = ?', 'tagged-token')
      ).toEqual([]);
      expect((await untaggedWorld.runs.get(kept.runId)).workflowName).toBe(
        'untagged-wf'
      );
      expect((await otherWorld.runs.get(other.runId)).workflowName).toBe(
        'other-wf'
      );
      // Its token is free again.
      const next = await newRun(untaggedWorld);
      await updateRun(untaggedWorld, next.runId, 'run_started');
      const hook = await createHook(untaggedWorld, next.runId, {
        hookId: 'hook_next',
        token: 'tagged-token',
      });
      expect(hook.hookId).toBe('hook_next');

      await Promise.all(
        [untaggedWorld, taggedWorld, otherWorld].map((world) => world.close())
      );
    });

    it("does not reopen another tag's disposed hook", async () => {
      const world0 = createWorld({ dataDir: testDir, tag: 'vitest-0' });
      const world1 = createWorld({ dataDir: testDir, tag: 'vitest-1' });

      const run = await newRun(world1, 'hook-wf');
      await updateRun(world1, run.runId, 'run_started');
      const token = 'reused-token';
      await createHook(world1, run.runId, { hookId: 'hook_0', token });
      await disposeHook(world1, run.runId, 'hook_0');

      await world0.clear();

      const result = await world1.events.create(run.runId, {
        eventType: 'hook_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: 'hook_1',
        eventData: { token },
      });
      expect(result.event?.eventType).toBe('hook_created');
      expect(result.hook?.hookId).toBe('hook_1');
      // hook_0 stays disposed.
      await expect(
        world1.events.create(run.runId, {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'hook_0',
          eventData: { payload: new Uint8Array() },
        })
      ).rejects.toThrow();

      await world0.close();
      await world1.close();
    });

    it('deletes only its own queue messages', async () => {
      const tagged = createWorld({ dataDir: testDir, tag: 'vitest-0' });
      const db = databaseFor(testDir);
      for (const tag of ['vitest-0', null]) {
        db.run(
          `INSERT INTO messages (id, tag, queue_name, prefix, transport, body, visible_at, created_at)
           VALUES (?, ?, '__wkf_workflow_wf', '__wkf_workflow_', 'http', '{}', ?, ?)`,
          `msg_${tag ?? 'none'}`,
          tag,
          Date.now() + 3_600_000,
          new Date().toISOString()
        );
      }

      await tagged.clear();

      expect(db.all('SELECT id FROM messages')).toEqual([{ id: 'msg_none' }]);
      await tagged.close();
    });

    it('lists a stream written again after clear()', async () => {
      const world = createWorld({ dataDir: testDir, tag: 'vitest-0' });
      const run = await newRun(world);
      await world.streams.write(run.runId, 'strm_again', 'one');
      await world.clear();
      const again = await newRun(world);
      await world.streams.write(again.runId, 'strm_again', 'two');
      expect(await world.streams.list(again.runId)).toEqual(['strm_again']);
      await world.close();
    });
  });

  describe('untagged clear()', () => {
    it('deletes every tag, and the World stays usable', async () => {
      const untagged = createWorld({ dataDir: testDir });
      await newRun(untagged);
      await newRun(createStorage(testDir, 'vitest-0'));
      await createStreamer(testDir).streams.write('wrun_x', 'strm_x', 'chunk');

      await untagged.clear();

      expect(runTags()).toEqual([]);
      expect(databaseFor(testDir).all('SELECT 1 FROM stream_chunks')).toEqual(
        []
      );
      const run = await newRun(untagged, 'after-clear');
      expect((await untagged.runs.get(run.runId)).workflowName).toBe(
        'after-clear'
      );
      await untagged.close();
    });
  });

  describe('startup recovery', () => {
    it("recovers only its own tag's runs, and only those without a message", async () => {
      const app = createStorage(testDir);
      const tests = createStorage(testDir, 'vitest-0');
      const appRun = await newRun(app, 'app-wf');
      const queuedRun = await newRun(app, 'queued-wf');
      const testRun = await newRun(tests, 'test-wf');
      const db = databaseFor(testDir);
      db.run(
        `INSERT INTO messages (id, tag, queue_name, prefix, transport, body, run_id, visible_at, created_at)
         VALUES ('msg_queued', NULL, '__wkf_workflow_queued-wf', '__wkf_workflow_', 'http', '{}', ?, ?, ?)`,
        queuedRun.runId,
        Date.now() + 3_600_000,
        new Date().toISOString()
      );

      const recovering = createWorld({
        dataDir: testDir,
        baseUrl: 'http://127.0.0.1:1',
      });
      await recovering.start();
      const queued = db
        .all<{ run_id: string }>('SELECT run_id FROM messages')
        .map((row) => row.run_id);
      expect(queued.filter((id) => id === appRun.runId)).toHaveLength(1);
      expect(queued.filter((id) => id === queuedRun.runId)).toHaveLength(1);
      expect(queued).not.toContain(testRun.runId);

      await recovering.close();
    });
  });
});
