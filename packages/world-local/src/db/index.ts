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
import { debugLog, globalSingleton } from '@workflow/utils';
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
  /** A pending close (`brief` mode). */
  closeTimer?: ReturnType<typeof setTimeout>;
}

const state = globalSingleton('@workflow/world-local//sqlite', 1, () => ({
  connections: new Map<string, Connection>(),
  sweeper: null as ReturnType<typeof setInterval> | null,
  /** See {@link emptyDatabase}. */
  empty: undefined as Connection | undefined,
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
  if (connection.closeTimer) clearTimeout(connection.closeTimer);
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

/** Lock waits longer than this are logged under `DEBUG=workflow:*`. */
const SLOW_LOCK_DEBUG_MS = 250;
/** Lock waits longer than this are warned about. */
const SLOW_LOCK_WARN_MS = 5_000;

/**
 * Reports a long wait for the write lock: the thread was blocked meanwhile,
 * so a dev server that froze shows up here with the database it waited on.
 */
function reportLockWait(file: string, waitedMs: number): void {
  if (waitedMs >= SLOW_LOCK_WARN_MS) {
    console.warn(
      `[world-local] Waited ${waitedMs}ms for the write lock of ${file}: another process held it.`
    );
  } else if (waitedMs >= SLOW_LOCK_DEBUG_MS) {
    debugLog(`[world-local] waited ${waitedMs}ms for the write lock`, { file });
  }
}

/**
 * Runs `fn`, retrying (with a short synchronous pause) while SQLite reports
 * the database busy without waiting (it does not for a few operations, such
 * as switching to WAL). Bounded by the busy timeout overall: a statement
 * that already waited `busy_timeout` is not retried.
 */
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
    // Freed pages are zeroed, so data a zero-retention purge deletes does not
    // linger in the file.
    raw.exec('PRAGMA secure_delete = ON');
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
  if (connectionMode() === 'keep') ensureSweeper();
  return connection;
}

/**
 * An empty database with the current schema, in memory: what reads see while
 * the data directory has no database file yet. A read never creates the
 * file, or the directory (the CLI or web UI pointed at an app that has not
 * run yet must not write into its data directory); the first write does.
 * Never written to, so one serves every data directory.
 *
 * Once the file exists, a read opens it like a write does: a file another
 * process has created but not yet set up (WAL mode, the schema) is set up by
 * whichever connection opens it first, reader or writer.
 */
function emptyDatabase(): Connection {
  if (!state.empty) {
    const raw = openRawDatabase(':memory:');
    migrate(raw);
    state.empty = {
      file: ':memory:',
      raw,
      identity: null,
      lastUsed: Date.now(),
      depth: 0,
    };
  }
  return state.empty;
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

  /** The connection for a read: an empty database while there is no file. */
  private readConnection(): Connection {
    if (!state.connections.has(this.file) && !fs.existsSync(this.file)) {
      return emptyDatabase();
    }
    return this.connection();
  }

  prepare(sql: string): Statement {
    return this.connection().raw.prepare(sql);
  }

  get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): T | undefined {
    return this.released(
      () =>
        this.readConnection()
          .raw.prepare(sql)
          .get(...(params as never[])) as T | undefined
    );
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.released(
      () =>
        this.readConnection()
          .raw.prepare(sql)
          .all(...(params as never[])) as T[]
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
   * {@link connectionMode}), releases the connection after it.
   */
  private released<T>(fn: () => T): T {
    try {
      return fn();
    } finally {
      this.afterOperation();
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
    else {
      const waitStarted = Date.now();
      retryWhileBusy(() => connection.raw.exec('BEGIN IMMEDIATE'));
      reportLockWait(this.file, Date.now() - waitStarted);
    }
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
      if (!nested) this.afterOperation();
      throw error;
    }
    connection.depth--;
    try {
      connection.raw.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    } catch (error) {
      // COMMIT can fail (disk full, I/O error) with the transaction still
      // open on this connection: roll back and drop the connection, so the
      // next write starts clean instead of failing with "cannot start a
      // transaction within a transaction".
      if (!nested) {
        try {
          connection.raw.exec('ROLLBACK');
        } catch {}
        closeConnection(connection);
      }
      throw error;
    }
    connection.lastUsed = Date.now();
    if (!nested) this.afterOperation();
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
    const connection = this.readConnection();
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
      this.afterOperation();
    }
  }

  /** Releases the connection after a top-level operation, per {@link connectionMode}. */
  private afterOperation(): void {
    const mode = connectionMode();
    if (mode === 'keep') return;
    if (mode === 'none') {
      this.close();
      return;
    }
    const connection = state.connections.get(this.file);
    if (!connection) return;
    if (connection.closeTimer) clearTimeout(connection.closeTimer);
    connection.closeTimer = setTimeout(() => {
      connection.closeTimer = undefined;
      if (state.connections.get(this.file) === connection) this.close();
    }, BRIEF_IDLE_MS);
    connection.closeTimer.unref?.();
  }

  /**
   * Copies the WAL into the database and truncates it, so pages a write
   * replaced are gone from both files. Best effort: a reader in another
   * process can keep part of the WAL alive until it finishes.
   */
  checkpoint(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      this.released(() =>
        this.connection().raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      );
    } catch {}
  }

  /** Closes this process's connection to the file, if one is open. */
  close(): void {
    const existing = state.connections.get(this.file);
    if (existing && existing.depth === 0) closeConnection(existing);
  }
}

/** How long a connection stays open after its last operation, on Windows. */
const BRIEF_IDLE_MS = 25;

/**
 * How long a connection stays open between operations:
 *
 * - `keep` (default): until idle for a few seconds.
 * - `brief` (default on Windows): until the burst of operations using it is
 *   over. An open SQLite file cannot be deleted or renamed on Windows, so a
 *   connection kept open would stop a data directory from being removed (by
 *   `rm`, a test's cleanup, or the user) while the process runs.
 * - `none`: every operation opens and closes its own connection.
 *
 * `WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS=1|brief|0` overrides.
 */
export function connectionMode(): 'keep' | 'brief' | 'none' {
  const raw = process.env.WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS;
  if (raw === '0') return 'none';
  if (raw === '1') return 'keep';
  if (raw === 'brief') return 'brief';
  return process.platform === 'win32' ? 'brief' : 'keep';
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
