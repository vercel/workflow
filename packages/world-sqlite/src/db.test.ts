import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
