/**
 * Writers killed with SIGKILL at random points never leave the event log
 * and the entities it materializes disagreeing.
 *
 * Earlier releases wrote one change as several files (a claim, the entity,
 * the event), and each crash window between them needed its own repair. Now
 * every `events.create` is one SQLite transaction, so this checks the
 * property once, over whatever instants the kills happen to land on, instead
 * of reproducing each window.
 */

import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Event, Step } from '@workflow/world';
import { eventIdToSlot } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decode } from '../db/codec.js';
import { databaseFor } from '../db/index.js';
import { createStorage } from '../storage.js';

const child = fileURLToPath(
  new URL('./crash-consistency.child.mjs', import.meta.url)
);

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-crash-'));
});

afterEach(async () => {
  databaseFor(testDir).close();
  await fs.rm(testDir, { recursive: true, force: true });
});

function startWriter(writer: string) {
  const proc = fork(child, [testDir, writer], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const ready = new Promise<void>((resolve, reject) => {
    proc.once('message', () => resolve());
    proc.once('exit', (code) =>
      reject(new Error(`writer exited (${code}) before it was ready`))
    );
  });
  const exited = new Promise<void>((resolve) =>
    proc.once('exit', () => resolve())
  );
  return { proc, ready, exited };
}

describe('crash consistency (world-local)', () => {
  it('a SIGKILL at any point leaves every entity backed by its events, and every log dense', async () => {
    for (let round = 0; round < 12; round++) {
      const writers = [1, 2, 3].map((i) => startWriter(`${round}-${i}`));
      await Promise.all(writers.map((writer) => writer.ready));
      await new Promise((resolve) =>
        setTimeout(resolve, 40 + Math.random() * 120)
      );
      for (const writer of writers) writer.proc.kill('SIGKILL');
      await Promise.all(writers.map((writer) => writer.exited));
    }

    const db = databaseFor(testDir);
    const runs = db.all<{ run_id: string; status: string; seq: number }>(
      'SELECT run_id, status, seq FROM runs'
    );
    expect(runs.length).toBeGreaterThan(0);
    for (const { run_id: runId, status, seq } of runs) {
      const events = db
        .all<{ seq: number; doc: string }>(
          'SELECT seq, doc FROM events WHERE run_id = ? ORDER BY seq',
          runId
        )
        .map((row) => ({
          seq: Number(row.seq),
          event: decode<Event>(row.doc),
        }));
      // Dense, from 1, and the run's position counter agrees.
      expect(events.map((e) => e.seq)).toEqual(
        events.map((_, index) => index + 1)
      );
      expect(Number(seq)).toBe(events.length);
      expect(
        events.every((e) => eventIdToSlot(e.event.eventId) === e.seq)
      ).toBe(true);
      expect(events[0]?.event.eventType).toBe('run_created');
      const types = events.map((e) => e.event.eventType);
      // The run's status is the one its log ends in.
      expect(status).toBe(
        types.includes('run_completed')
          ? 'completed'
          : types.includes('run_started')
            ? 'running'
            : 'pending'
      );
      // Every step row is the fold of its events.
      for (const row of db.all<{ doc: string }>(
        'SELECT doc FROM steps WHERE run_id = ?',
        runId
      )) {
        const step = decode<Step>(row.doc);
        const own = events
          .map((e) => e.event)
          .filter((e) => e.correlationId === step.stepId)
          .map((e) => e.eventType);
        expect(own[0]).toBe('step_created');
        expect(step.status).toBe(
          own.includes('step_completed')
            ? 'completed'
            : own.includes('step_started')
              ? 'running'
              : 'pending'
        );
      }
      // Every hook that holds a token has its hook_created.
      for (const row of db.all<{ hook_id: string }>(
        'SELECT hook_id FROM hook_tokens WHERE run_id = ?',
        runId
      )) {
        expect(
          events.some(
            (e) =>
              e.event.eventType === 'hook_created' &&
              e.event.correlationId === row.hook_id
          )
        ).toBe(true);
      }
    }
    expect(Object.values(db.get('PRAGMA integrity_check') ?? {})).toEqual([
      'ok',
    ]);

    // And the data directory is still writable: no lock outlived its holder.
    const storage = createStorage(testDir);
    const created = await storage.events.create(null, {
      eventType: 'run_created',
      specVersion: 8,
      eventData: {
        deploymentId: 'dpl_crash',
        workflowName: 'after',
        input: new Uint8Array(),
      },
    });
    expect(created.event?.eventId).toBeDefined();
  }, 120_000);
});
