import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
// Far above a single write (well under a millisecond), below a lock wait that
// blocks the thread: with the busy handler waiting synchronously, the longest
// gap here was 430 ms to over a second in every run. That the wait itself
// never blocks is pinned deterministically by write-lock-wait.test.ts; this
// test checks it holds across processes under real contention.
const MAX_HEARTBEAT_GAP_MS = 250;
// On a shared CI runner (every package's tests at once, a few cores) a busy
// process's scheduling gaps are too noisy to bound reliably: there the test
// reports the gaps and checks every write, and write-lock-wait.test.ts guards
// the lock wait. Elsewhere the bound applies.
const ENFORCE_GAP_BOUND = !process.env.CI;

let testDir: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-lock-'));
  // Connections kept open, in the writers too (they inherit the env): on
  // Windows world-local's tests otherwise open one per operation, which
  // makes thousands of writes too slow. Every connection is closed (or its
  // process gone) before the directory is removed.
  vi.stubEnv('WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS', '1');
});

afterEach(async () => {
  // A writer still running (a failed or timed-out test) holds world.db open.
  await Promise.all(
    children.splice(0).map(
      (proc) =>
        new Promise<void>((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) {
            resolve();
            return;
          }
          proc.once('exit', () => resolve());
          proc.kill();
        })
    )
  );
  databaseFor(testDir).close();
  vi.unstubAllEnvs();
  await fs.rm(testDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
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
  children.push(proc);
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
  // Busy like a writer, but writes nothing: on a loaded machine (CI runs
  // every package's tests at once) a busy process can go unscheduled for a
  // while whatever it runs, and this measures how long.
  const control = startWriter('control', 0);
  await Promise.all([...writers, control].map((writer) => writer.ready));
  for (const writer of [...writers, control]) writer.proc.send('go');
  const reports = await Promise.all(writers.map((writer) => writer.report));
  control.proc.send('stop');
  const noise = (await control.report).maxGapMs;

  const gaps = reports.map((report) => Math.round(report.maxGapMs));
  // A writer also does real synchronous work the control doesn't (SQLite
  // checkpoints the WAL inside the commit that fills it, and disk I/O slows
  // down on a loaded machine), so under load its gaps run several times the
  // control's.
  const bound = Math.max(MAX_HEARTBEAT_GAP_MS, 6 * noise + 50);
  const summary = `longest heartbeat gaps: ${gaps}; control: ${Math.round(noise)}; bound: ${Math.round(bound)}`;
  if (ENFORCE_GAP_BOUND) {
    expect(Math.max(...gaps), summary).toBeLessThan(bound);
  } else {
    console.info(`[lock-contention] ${summary} (not enforced on CI)`);
  }

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
