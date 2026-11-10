import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { databaseFor } from './index.js';

/**
 * Several processes writing to one data directory (an app and a test runner,
 * or `@workflow/vitest`'s workers) wait for each other's write lock. That
 * wait must not block the thread: a write waiting synchronously for the lock
 * froze the event loop (no timers, no requests served) for up to a second
 * with 8 writers. Each writer here runs a 1 ms heartbeat; its longest gap is
 * how long its thread was blocked.
 */

const child = fileURLToPath(
  new URL('./lock-contention.child.mjs', import.meta.url)
);
const WRITERS = 6;
const RUNS_PER_WRITER = 100;
const EVENTS_PER_RUN = 12;
// Far above a single write (well under a millisecond), far below a lock
// wait that blocks the thread (180 ms to over a second here, before).
const MAX_HEARTBEAT_GAP_MS = 150;

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-lock-'));
});

afterEach(async () => {
  databaseFor(testDir).close();
  await fs.rm(testDir, { recursive: true, force: true });
});

interface Report {
  status: 'done';
  maxGapMs: number;
  runIds: string[];
}

function startWriter(writer: string, runs = RUNS_PER_WRITER) {
  const proc = fork(child, [testDir, writer, String(runs)], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const ready = new Promise<void>((resolve, reject) => {
    proc.once('message', () => resolve());
    proc.once('exit', (code) =>
      reject(new Error(`writer exited (${code}) before it was ready`))
    );
  });
  const report = ready.then(
    () =>
      new Promise<Report>((resolve, reject) => {
        proc.on('message', (message) => {
          if ((message as Report).status === 'done') resolve(message as Report);
        });
        proc.once('exit', (code) =>
          reject(new Error(`writer exited (${code}) before it reported`))
        );
      })
  );
  return { proc, ready, report };
}

it('writers waiting for each other never block their thread', async () => {
  // The schema exists before the writers race to open the file.
  databaseFor(testDir).get('SELECT 1');
  const writers = Array.from({ length: WRITERS }, (_, i) =>
    startWriter(`w${i}`)
  );
  // Writes nothing: on a loaded machine (CI runs every package's tests at
  // once) a process can go unscheduled for a while whatever it runs, and
  // this measures how long.
  const control = startWriter('control', 0);
  await Promise.all([...writers, control].map((writer) => writer.ready));
  for (const writer of [...writers, control]) writer.proc.send('go');
  const reports = await Promise.all(writers.map((writer) => writer.report));
  control.proc.send('stop');
  const noise = (await control.report).maxGapMs;

  const gaps = reports.map((report) => Math.round(report.maxGapMs));
  expect(
    Math.max(...gaps),
    `longest heartbeat gaps: ${gaps}; control: ${Math.round(noise)}`
  ).toBeLessThan(Math.max(MAX_HEARTBEAT_GAP_MS, 2 * noise + 50));

  // Every write committed, and every log is dense.
  const db = databaseFor(testDir);
  const runIds = reports.flatMap((report) => report.runIds);
  expect(runIds).toHaveLength(WRITERS * RUNS_PER_WRITER);
  for (const runId of runIds) {
    const seqs = db
      .all<{ seq: number }>(
        'SELECT seq FROM events WHERE run_id = ? ORDER BY seq',
        runId
      )
      .map((row) => Number(row.seq));
    expect(seqs).toEqual(
      Array.from({ length: EVENTS_PER_RUN }, (_, i) => i + 1)
    );
  }
}, 120_000);
