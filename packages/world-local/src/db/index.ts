/**
 * The data directory's database: one SQLite file, `<dataDir>/world.db`.
 *
 * Every World write is one short transaction (`transact`). SQLite's write
 * lock is an OS file lock (`fcntl` on Unix, `LockFileEx` on Windows) that
 * the kernel releases when its process dies, so a crashed writer leaves
 * nothing behind to detect, time out or repair: its transaction never
 * committed. WAL mode lets readers in every process read while one writes.
 *
 * Connections are shared per database file within a process (on
 * `globalThis`, so every bundled copy of this package shares them too), and
 * closed once idle. A connection is reopened when its file was deleted or
 * replaced underneath it (a test that removes its data directory and creates
 * it again), so a write never lands in an unlinked file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { globalSingleton } from '@workflow/utils';
import { openRawDatabase, type RawDatabase, type Statement } from './driver.js';
import { migrate } from './schema.js';

export type { Statement } from './driver.js';

export const DATABASE_FILE_NAME = 'world.db';

/** How long an unused connection stays open. */
const IDLE_CLOSE_MS = 5_000;

/** How long `BEGIN IMMEDIATE` waits for another process's write lock. */
const BUSY_TIMEOUT_MS = 30_000;

interface Connection {
  file: string;
  raw: RawDatabase;
  /** `dev:ino` of the file when opened; a mismatch means it was replaced. */
  identity: string | null;
  lastUsed: number;
  /** Transaction nesting depth (savepoints below the outermost). */
  depth: number;
}

const state = globalSingleton('@workflow/world-local//sqlite', 1, () => ({
  connections: new Map<string, Connection>(),
  sweeper: null as ReturnType<typeof setInterval> | null,
}));

function fileIdentity(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function closeConnection(connection: Connection): void {
  state.connections.delete(connection.file);
  try {
    connection.raw.close();
  } catch {
    // Already closed.
  }
}

function ensureSweeper(): void {
  if (state.sweeper) return;
  state.sweeper = setInterval(() => {
    const now = Date.now();
    for (const connection of [...state.connections.values()]) {
      if (connection.depth === 0 && now - connection.lastUsed > IDLE_CLOSE_MS) {
        closeConnection(connection);
      }
    }
    if (state.connections.size === 0 && state.sweeper) {
      clearInterval(state.sweeper);
      state.sweeper = null;
    }
  }, 1_000);
  state.sweeper.unref?.();
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|database table is locked/i.test(
    message
  );
}

/** Runs `fn`, retrying (with a short synchronous pause) while SQLite is busy. */
function retryWhileBusy<T>(fn: () => T): T {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (!isBusyError(error) || Date.now() >= deadline) throw error;
      Atomics.wait(pause, 0, 0, Math.min(50, 2 ** attempt));
    }
  }
}

function open(file: string): Connection {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = openRawDatabase(file);
  try {
    raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Switching to WAL needs a lock SQLite does not wait for (no busy
    // handler), and is a no-op once the file is in WAL mode, which is
    // persistent: so it is only attempted when needed, and retried while
    // another connection holds the file (opening or closing it).
    retryWhileBusy(() => {
      const mode = raw.prepare('PRAGMA journal_mode').get() as
        | { journal_mode?: string }
        | undefined;
      if (String(mode?.journal_mode).toLowerCase() !== 'wal') {
        raw.exec('PRAGMA journal_mode = WAL');
      }
    });
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec('PRAGMA foreign_keys = ON');
    retryWhileBusy(() => migrate(raw));
  } catch (error) {
    raw.close();
    throw error;
  }
  const connection: Connection = {
    file,
    raw,
    identity: fileIdentity(file),
    lastUsed: Date.now(),
    depth: 0,
  };
  state.connections.set(file, connection);
  if (keepsConnections()) ensureSweeper();
  return connection;
}

function acquire(file: string): Connection {
  const existing = state.connections.get(file);
  if (existing) {
    if (existing.depth > 0) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (
      existing.identity !== null &&
      fileIdentity(file) === existing.identity
    ) {
      existing.lastUsed = Date.now();
      return existing;
    }
    closeConnection(existing);
  }
  return open(file);
}

/** A handle to one data directory's database. Cheap; holds no connection. */
export class Database {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, DATABASE_FILE_NAME);
  }

  private connection(): Connection {
    return acquire(this.file);
  }

  prepare(sql: string): Statement {
    return this.connection().raw.prepare(sql);
  }

  get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): T | undefined {
    return this.released(
      () => this.prepare(sql).get(...(params as never[])) as T | undefined
    );
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.released(
      () => this.prepare(sql).all(...(params as never[])) as T[]
    );
  }

  run(sql: string, ...params: unknown[]): number {
    return this.released(() =>
      Number(this.prepare(sql).run(...(params as never[])).changes)
    );
  }

  exec(sql: string): void {
    this.released(() => this.connection().raw.exec(sql));
  }

  /**
   * Runs one top-level operation and, when connections are not kept (see
   * {@link keepsConnections}), closes the connection after it.
   */
  private released<T>(fn: () => T): T {
    try {
      return fn();
    } finally {
      if (!keepsConnections()) this.close();
    }
  }

  /**
   * Runs `fn` in one write transaction (`BEGIN IMMEDIATE`), committing its
   * writes together or not at all. `fn` must be synchronous: nothing may
   * await inside a transaction. Nested calls run in a savepoint.
   *
   * `fn` may return a {@link CommitThenThrow} to commit what it wrote (a
   * recorded refusal, say) and then throw.
   */
  transact<T>(fn: () => T): T {
    const connection = this.connection();
    const nested = connection.depth > 0;
    const savepoint = `sp_${connection.depth}`;
    if (nested) connection.raw.exec(`SAVEPOINT ${savepoint}`);
    else retryWhileBusy(() => connection.raw.exec('BEGIN IMMEDIATE'));
    connection.depth++;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) {
        throw new Error('world-local: a transaction body must be synchronous');
      }
    } catch (error) {
      connection.depth--;
      try {
        connection.raw.exec(
          nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'
        );
      } catch {
        // The transaction was already rolled back (for example by SQLite on
        // a disk-full error).
      }
      if (!nested && !keepsConnections()) this.close();
      throw error;
    }
    connection.depth--;
    connection.raw.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    connection.lastUsed = Date.now();
    if (!nested && !keepsConnections()) this.close();
    if (result instanceof CommitThenThrow) {
      throw result.error;
    }
    return result;
  }

  /**
   * Runs `fn`, a group of reads, against one consistent snapshot of the
   * database (a deferred read transaction), so a write another process
   * commits in between cannot be half seen. `fn` must be synchronous.
   */
  snapshot<T>(fn: () => T): T {
    const connection = this.connection();
    if (connection.depth > 0) return fn();
    retryWhileBusy(() => connection.raw.exec('BEGIN'));
    connection.depth++;
    try {
      return fn();
    } finally {
      connection.depth--;
      try {
        connection.raw.exec('COMMIT');
      } catch {}
      connection.lastUsed = Date.now();
      if (!keepsConnections()) this.close();
    }
  }

  /** Closes this process's connection to the file, if one is open. */
  close(): void {
    const existing = state.connections.get(this.file);
    if (existing && existing.depth === 0) closeConnection(existing);
  }
}

/**
 * Whether connections stay open between operations (until idle). On Windows
 * an open SQLite file cannot be deleted or renamed, so a connection kept open
 * would stop a data directory from being removed (by `rm`, a test's cleanup,
 * or the user) while the process runs; there, every operation opens and
 * closes its own. `WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS=0|1` overrides.
 */
export function keepsConnections(): boolean {
  const raw = process.env.WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS;
  if (raw === '0') return false;
  if (raw === '1') return true;
  return process.platform !== 'win32';
}

/** Closes every connection this process holds (none mid-transaction). */
export function closeAllDatabases(): void {
  for (const connection of [...state.connections.values()]) {
    if (connection.depth === 0) closeConnection(connection);
  }
}

/** Returned from a `transact` body: commit, then throw `error`. */
export class CommitThenThrow {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}

/** The database of `dataDir`. */
export function databaseFor(dataDir: string): Database {
  return new Database(dataDir);
}
