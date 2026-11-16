import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openRawDatabase } from './driver.js';
import { closeAllDatabases, databaseFor } from './index.js';

/**
 * A write waiting for another connection's write lock (another process on
 * the data directory, here a second connection in this one) waits without
 * blocking the thread: timers keep firing, and the write commits once the
 * lock is released. A wait inside SQLite's busy handler would block the
 * thread, so the holder here could never release and the write would fail
 * after the busy timeout instead.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'write-lock-wait-'));
});

afterEach(() => {
  closeAllDatabases();
  rmSync(dataDir, { recursive: true, force: true });
});

it('waits for another connection’s write lock without blocking the thread', async () => {
  const db = databaseFor(dataDir);
  db.exec('CREATE TABLE IF NOT EXISTS probe (n INTEGER)');

  const holder = openRawDatabase(path.join(dataDir, 'world.db'));
  holder.exec('PRAGMA busy_timeout = 0');
  holder.exec('BEGIN IMMEDIATE');

  const write = db.transactAsync(() => {
    db.run('INSERT INTO probe (n) VALUES (1)');
    return 'committed';
  });
  let settled = false;
  void write.then(() => {
    settled = true;
  });

  // The thread is free while the write waits: this timer fires, and the
  // write has not gone through.
  const ticks = await new Promise<number>((resolve) => {
    let n = 0;
    const timer = setInterval(() => {
      if (++n === 5) {
        clearInterval(timer);
        resolve(n);
      }
    }, 10);
  });
  expect(ticks).toBe(5);
  expect(settled).toBe(false);

  holder.exec('COMMIT');
  holder.close();
  await expect(write).resolves.toBe('committed');
  expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM probe')?.n).toBe(1);
});
