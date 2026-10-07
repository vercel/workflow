import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  Db,
  decode,
  encode,
  MIN_SQLITE_VERSION,
  SqliteVersionError,
} from './db.js';

describe('db', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('3.51.3', '3.51.3')).toBe(0);
    expect(compareVersions('3.51.2', '3.51.3')).toBeLessThan(0);
    expect(compareVersions('3.100.0', '3.51.3')).toBeGreaterThan(0);
    expect(compareVersions('3.52', '3.51.3')).toBeGreaterThan(0);
  });

  it('names the minimum and the bundled version when SQLite is too old', () => {
    const error = new SqliteVersionError('3.50.4');
    expect(error.message).toContain(`>= ${MIN_SQLITE_VERSION}`);
    expect(error.message).toContain('3.50.4');
  });

  it('opens in WAL mode on a SQLite new enough to share', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wsqlite-db-'));
    const db = new Db(path.join(dir, 'workflow.sqlite'));
    const version = db.get<{ v: string }>('SELECT sqlite_version() AS v')!.v;
    expect(compareVersions(version, MIN_SQLITE_VERSION)).toBeGreaterThanOrEqual(
      0
    );
    expect(
      db.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode
    ).toBe('wal');
    db.close();
  });

  it('creates stores with incremental auto_vacuum and reclaims freed pages', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wsqlite-db-'));
    const db = new Db(path.join(dir, 'workflow.sqlite'));
    expect(
      db.get<{ auto_vacuum: number }>('PRAGMA auto_vacuum')!.auto_vacuum
    ).toBe(2);
    const pages = () =>
      db.get<{ page_count: number }>('PRAGMA page_count')!.page_count;
    const free = () =>
      db.get<{ freelist_count: number }>('PRAGMA freelist_count')!
        .freelist_count;
    const blob = 'x'.repeat(16 * 1024);
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        db.run('INSERT INTO meta (key, value) VALUES (?, ?)', `k${i}`, blob);
      }
    });
    const filled = pages();
    const vacuums: boolean[] = [];
    const exec = db.raw.exec.bind(db.raw);
    db.raw.exec = (sql: string) => {
      if (sql.includes('incremental_vacuum')) {
        vacuums.push(db.raw.isTransaction);
      }
      return exec(sql);
    };
    db.transaction(() => {
      db.run("DELETE FROM meta WHERE key LIKE 'k%'");
    });
    // The deleting transaction returns at most 256 pages itself...
    const afterDelete = free();
    expect(afterDelete).toBeGreaterThan(1024);
    // ...and each later write transaction returns up to 256 more, down to the
    // 1024-page reserve.
    let commits = 0;
    while (free() > 1024 && commits < 100) {
      db.transaction(() => {
        db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('tick', '')");
      });
      commits++;
    }
    expect(free()).toBe(1024);
    // Every reclaim ran inside a write transaction that already held the
    // lock, so it can never wait on, or be refused by, another connection.
    expect(vacuums.length).toBeGreaterThan(0);
    expect(vacuums.every((inTransaction) => inTransaction)).toBe(true);
    expect(commits).toBe(Math.ceil((afterDelete - 1024) / 256));
    expect(pages()).toBeLessThan(filled / 2);
    db.close();
  });

  it('reclaims under four concurrent writer processes without blocking or SQLITE_BUSY', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wsqlite-db-'));
    const file = path.join(dir, 'workflow.sqlite');
    new Db(file).close();
    const dbModule = pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'db.ts')
    ).href;
    // Each writer repeatedly inserts ~2 MiB of rows, then deletes them, so
    // the shared file keeps crossing the reclaim threshold while the other
    // three hold or queue for the write lock.
    const child = `
      const { Db } = await import(${JSON.stringify(dbModule)});
      const id = process.argv[1];
      const db = new Db(${JSON.stringify(file)});
      const blob = 'x'.repeat(8 * 1024);
      let reclaimingCommits = 0;
      let maxReclaimMs = 0;
      const free = () => Number(db.get('PRAGMA freelist_count').freelist_count);
      for (let round = 0; round < 15; round++) {
        db.transaction(() => {
          for (let i = 0; i < 256; i++) {
            db.run('INSERT INTO meta (key, value) VALUES (?, ?)', id + ':' + round + ':' + i, blob);
          }
        });
        let before = 0;
        const start = performance.now();
        db.transaction(() => {
          db.run('DELETE FROM meta WHERE key LIKE ?', id + ':' + round + ':%');
          before = free();
        });
        if (before > 1024) {
          reclaimingCommits++;
          maxReclaimMs = Math.max(maxReclaimMs, performance.now() - start);
        }
      }
      db.close();
      process.stdout.write(JSON.stringify({ reclaimingCommits, maxReclaimMs }));
    `;
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map(
        (id) =>
          new Promise<{ reclaimingCommits: number; maxReclaimMs: number }>(
            (resolve, reject) => {
              execFile(
                process.execPath,
                ['--input-type=module', '-e', child, id],
                { env: { ...process.env, NODE_NO_WARNINGS: '1' } },
                (error, stdout, stderr) => {
                  if (error) reject(new Error(`${error.message}\n${stderr}`));
                  else resolve(JSON.parse(stdout));
                }
              );
            }
          )
      )
    );
    const reclaiming = results.reduce((n, r) => n + r.reclaimingCommits, 0);
    expect(reclaiming).toBeGreaterThan(0);
    const db = new Db(file);
    expect(
      db.get<{ freelist_count: number }>('PRAGMA freelist_count')!
        .freelist_count
    ).toBeLessThanOrEqual(1024 + 4 * 256 * 3);
    expect(
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM meta WHERE key LIKE '%:%'"
      )!.n
    ).toBe(0);
    db.close();
  }, 60_000);

  it('round-trips bytes natively and dates as JSON would', () => {
    const value = decode(
      encode({
        bytes: new Uint8Array([1, 2]),
        at: new Date(0),
        gone: undefined,
      })
    );
    expect(value.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(value.bytes)).toEqual([1, 2]);
    expect(value.at).toBe('1970-01-01T00:00:00.000Z');
    expect('gone' in value).toBe(false);
  });
});
