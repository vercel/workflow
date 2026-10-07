import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { deserialize, serialize } from 'node:v8';
import { WorkflowWorldError } from '@workflow/errors';

/**
 * Oldest SQLite this world runs on. 3.51.3 fixes a WAL-reset bug that can
 * corrupt a database written by several connections at once — exactly how a
 * dev server, the CLI and the web UI share one store.
 */
export const MIN_SQLITE_VERSION = '3.51.3';

/** Schema version stored in `meta.schema_version`. */
export const SCHEMA_VERSION = 1;

/** Free pages (4 KiB each) that trigger an incremental vacuum: 4 MiB. */
const FREE_PAGES_RECLAIM_THRESHOLD = 1024;
/** Free pages an incremental vacuum leaves in place for upcoming writes. */
const FREE_PAGES_SLACK = 256;

const BUSY_TIMEOUT_MS = 5_000;

export class SqliteVersionError extends WorkflowWorldError {
  constructor(found: string) {
    super(
      `@workflow/world-sqlite requires SQLite >= ${MIN_SQLITE_VERSION}, but ` +
        `node:sqlite in Node.js ${process.version} bundles SQLite ${found}. ` +
        `Upgrade Node.js (a current Node 24+ release bundles a fixed SQLite).`
    );
    this.name = 'SqliteVersionError';
  }
}

export class SqliteUnavailableError extends WorkflowWorldError {
  constructor(cause: unknown) {
    super(
      `@workflow/world-sqlite needs the built-in node:sqlite module, which ` +
        `Node.js ${process.version} does not provide. Use Node.js 22.13+ ` +
        `(24+ recommended).`,
      { cause }
    );
    this.name = 'SqliteUnavailableError';
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let sqliteModule: typeof import('node:sqlite') | undefined;

function loadSqlite(): typeof import('node:sqlite') {
  if (sqliteModule) return sqliteModule;
  try {
    // Loaded lazily so importing this package (e.g. for its types, or by a
    // bundler tracing the target world) never fails on a runtime without it.
    const require = createRequire(import.meta.url);
    sqliteModule = require('node:sqlite') as typeof import('node:sqlite');
  } catch (error) {
    throw new SqliteUnavailableError(error);
  }
  return sqliteModule;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per workflow run. "data" holds the full WorkflowRun record.
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  status TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_created ON runs (created_at, run_id);

-- The event log. "seq" is the event's position in its run's log: equal to
-- the slot in a slot-numbered event id, and still the replay order for
-- legacy ULID-numbered runs.
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  event_type TEXT NOT NULL,
  correlation_id TEXT,
  resume_id TEXT,
  created_at INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS events_by_id ON events (run_id, event_id);
CREATE INDEX IF NOT EXISTS events_by_correlation
  ON events (run_id, correlation_id, seq);

-- Steps. The step input is not stored here: it lives once, on the step's
-- step_created event (input_seq), and is joined in on read.
CREATE TABLE IF NOT EXISTS steps (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  input_seq INTEGER,
  output_seq INTEGER,
  data BLOB NOT NULL,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS hooks (
  hook_id TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  run_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS hooks_by_run ON hooks (run_id);
CREATE INDEX IF NOT EXISTS hooks_by_token ON hooks (token);

-- Token ownership: at most one live hook holds a token.
CREATE TABLE IF NOT EXISTS hook_tokens (
  token TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  data BLOB NOT NULL
);

-- (runId, resumeId) dedup for lazy hook resumes.
CREATE TABLE IF NOT EXISTS hook_resumes (
  run_id TEXT NOT NULL,
  resume_id TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_digest TEXT,
  PRIMARY KEY (run_id, resume_id)
);

CREATE TABLE IF NOT EXISTS waits (
  wait_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS waits_by_run ON waits (run_id);

-- Write-once markers: entity-creation claims, terminal claims, hook
-- disposals. A row's presence is the fact; "data" carries optional detail.
CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS stream_chunks (
  stream_name TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  eof INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (stream_name, chunk_id)
);

CREATE TABLE IF NOT EXISTS run_streams (
  run_id TEXT NOT NULL,
  stream_name TEXT NOT NULL,
  tag TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (run_id, stream_name)
);

CREATE TABLE IF NOT EXISTS snapshots (
  run_id TEXT PRIMARY KEY,
  data BLOB NOT NULL
);
`;

export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

/**
 * A synchronous handle on one SQLite connection.
 *
 * Every storage operation runs as one synchronous transaction: node:sqlite is
 * synchronous, so nothing else in this process can interleave with a
 * transaction, and `BEGIN IMMEDIATE` takes the write lock up front so other
 * processes queue behind it (for up to the busy timeout) instead of failing
 * with SQLITE_BUSY halfway through.
 */
export class Db {
  readonly file: string;
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private dataVersionStatement: StatementSync | undefined;
  private closed = false;

  constructor(file: string) {
    this.file = file;
    const { DatabaseSync } = loadSqlite();
    if (file !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
    this.raw = db;
    const version = (
      db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    ).v;
    if (compareVersions(version, MIN_SQLITE_VERSION) < 0) {
      db.close();
      throw new SqliteVersionError(version);
    }
    // Must precede the first CREATE TABLE; a no-op on an existing store
    // created without it. Deleted rows are then returned to the filesystem
    // by `reclaimFreePages` instead of staying in the file as free pages.
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = OFF');
    this.transaction(() => {
      db.exec(SCHEMA);
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      if (!row) {
        db.prepare(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?)"
        ).run(String(SCHEMA_VERSION));
      } else if (Number(row.value) > SCHEMA_VERSION) {
        throw new WorkflowWorldError(
          `SQLite store ${file} has schema version ${row.value}, newer than ` +
            `this @workflow/world-sqlite supports (${SCHEMA_VERSION}). ` +
            `Upgrade @workflow/world-sqlite.`
        );
      }
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SqlValue[]): { changes: number } {
    const result = this.statement(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  /**
   * Runs `fn` inside one write transaction (`BEGIN IMMEDIATE`). Nested calls
   * join the outer transaction. `fn` must be synchronous: awaiting inside it
   * would let another caller on this connection start a transaction of its
   * own in the gap.
   */
  transaction<T>(fn: () => T): T {
    if (this.raw.isTransaction) {
      return fn();
    }
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result instanceof Promise) {
        throw new Error('Db.transaction callbacks must be synchronous');
      }
      this.raw.exec('COMMIT');
      this.reclaimFreePages();
      return result;
    } catch (error) {
      if (this.raw.isTransaction) {
        this.raw.exec('ROLLBACK');
      }
      throw error;
    }
  }

  /**
   * Truncates the file once deletes and shrinking rows leave more than
   * {@link FREE_PAGES_RECLAIM_THRESHOLD} free pages, keeping
   * {@link FREE_PAGES_SLACK} for upcoming writes. Reading the free-page count
   * is a header read, so this is cheap on the commits that skip it. Never
   * throws: a busy store just keeps its free pages until a later commit.
   */
  reclaimFreePages(): void {
    try {
      const free = Number(
        (this.get('PRAGMA freelist_count') as { freelist_count: number })
          .freelist_count
      );
      if (free < FREE_PAGES_RECLAIM_THRESHOLD) return;
      this.raw.exec(`PRAGMA incremental_vacuum(${free - FREE_PAGES_SLACK})`);
    } catch {
      // Reclaiming is an optimization; the data is already committed.
    }
  }

  /**
   * `PRAGMA data_version`: changes whenever another connection commits.
   * Lets a poller skip its query when nothing outside this connection wrote.
   */
  dataVersion(): number {
    if (!this.dataVersionStatement) {
      this.dataVersionStatement = this.raw.prepare('PRAGMA data_version');
    }
    const row = this.dataVersionStatement.get() as { data_version: number };
    return Number(row.data_version);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.dataVersionStatement = undefined;
    this.raw.close();
  }
}

/**
 * Copies `value` into the shape a JSON round trip would leave it in (no
 * `undefined` properties, `Date`s as ISO strings), while keeping
 * `Uint8Array` values native so binary payloads are stored as bytes rather
 * than base64. Readers parse records through the World schemas, which coerce
 * the entity timestamps back to `Date`, exactly as world-local's JSON does.
 */
function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Uint8Array) {
    // A Buffer would come back from v8.deserialize as a Buffer; readers
    // expect the plain Uint8Array world-local's JSON reviver produces.
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : normalize(item)));
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return normalize((value as { toJSON(): unknown }).toJSON());
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || typeof item === 'function') continue;
    out[key] = normalize(item);
  }
  return out;
}

/** Serializes a record for a `data` column. */
export function encode(value: unknown): Uint8Array {
  return serialize(normalize(value));
}

/** Inverse of {@link encode}. */
export function decode<T = any>(data: SqlValue): T {
  if (!(data instanceof Uint8Array)) {
    throw new WorkflowWorldError('Corrupt row: expected a BLOB data column');
  }
  return deserialize(data) as T;
}

/** Normalizes the tag option: untagged rows carry `''`. */
export function tagValue(tag: string | undefined): string {
  return tag ?? '';
}

/** A `Date` (or date-like) as epoch milliseconds for an INTEGER column. */
export function toMillis(value: Date | string | number): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
