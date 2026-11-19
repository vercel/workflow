/**
 * The SQLite driver world-local runs on: the runtime's built-in one.
 *
 * - Node.js: `node:sqlite` (`DatabaseSync`), unflagged from Node 22.13.
 * - Bun: `bun:sqlite`.
 *
 * Both are synchronous, which is the property the storage layer is built on:
 * a transaction runs from `BEGIN IMMEDIATE` to `COMMIT` without yielding to
 * the event loop, so nothing else in this process can interleave with it, and
 * SQLite's file lock orders it against every other process on the data
 * directory. No transaction ever spans an `await`.
 *
 * The module is loaded at runtime (`process.getBuiltinModule`, or a
 * `createRequire` require on Bun) rather than imported, so framework bundlers
 * never try to resolve or polyfill it.
 */

import { createRequire } from 'node:module';

/** A value SQLite can bind. `undefined` is bound as NULL. */
export type SqlValue = string | number | bigint | null | Uint8Array | undefined;

export interface Statement {
  run(...params: SqlValue[]): { changes: number | bigint };
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
}

export interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: Record<string, unknown>
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  };
}

interface BunSqliteModule {
  Database: new (
    path: string,
    options?: Record<string, unknown>
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  };
}

/** Thrown when this runtime has no built-in SQLite driver. */
export class SqliteUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      '@workflow/world-local needs a built-in SQLite driver: Node.js 22.13 or later (node:sqlite), or Bun (bun:sqlite). ' +
        `This runtime is ${describeRuntime()}.`,
      { cause }
    );
    this.name = 'SqliteUnavailableError';
  }
}

function describeRuntime(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? `Bun ${bun}` : `Node.js ${process.versions.node}`;
}

function isBun(): boolean {
  return (
    typeof (process.versions as Record<string, string | undefined>).bun ===
    'string'
  );
}

function loadModule<T>(specifier: string): T {
  const getBuiltinModule = (
    process as unknown as {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  if (typeof getBuiltinModule === 'function') {
    const loaded = getBuiltinModule.call(process, specifier);
    if (loaded) return loaded as T;
  }
  // Older runtimes without getBuiltinModule (and Bun's own modules on
  // versions that do not expose them through it).
  const base =
    typeof import.meta.url === 'string' && import.meta.url
      ? import.meta.url
      : `file://${process.cwd()}/`;
  return createRequire(base)(specifier) as T;
}

/**
 * Runs `fn` (loading `node:sqlite`) without the `ExperimentalWarning` Node.js
 * 22.13 to 22.x print for it, which every dev server, script and test worker
 * would otherwise show (Node.js 24 prints none). Only that warning is
 * dropped, and only while `fn` runs; any other warning goes through.
 */
function withoutSqliteExperimentalWarning<T>(fn: () => T): T {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (
    this: typeof process,
    warning: string | Error,
    ...rest: unknown[]
  ) {
    const type =
      typeof rest[0] === 'string'
        ? rest[0]
        : ((rest[0] as { type?: string } | undefined)?.type ??
          (warning instanceof Error ? warning.name : undefined));
    const message = warning instanceof Error ? warning.message : warning;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(String(message))) {
      return;
    }
    return (emitWarning as (...args: unknown[]) => void).call(
      this,
      warning,
      ...rest
    );
  } as typeof process.emitWarning;
  try {
    return fn();
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** Bind parameters: `undefined` becomes NULL, booleans become 0/1. */
function bind(params: unknown[]): unknown[] {
  for (let i = 0; i < params.length; i++) {
    const value = params[i];
    if (value === undefined) params[i] = null;
    else if (typeof value === 'boolean') params[i] = value ? 1 : 0;
  }
  return params;
}

function wrapStatement(statement: {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}): Statement {
  return {
    run: (...params) => statement.run(...bind(params)),
    get: (...params) =>
      (statement.get(...bind(params)) ?? undefined) as
        | Record<string, unknown>
        | undefined,
    all: (...params) =>
      statement.all(...bind(params)) as Record<string, unknown>[],
  };
}

/** Opens a SQLite database file with this runtime's built-in driver. */
export function openRawDatabase(filePath: string): RawDatabase {
  let db: {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  };
  try {
    if (isBun()) {
      const { Database } = loadModule<BunSqliteModule>('bun:sqlite');
      db = new Database(filePath, { create: true });
    } else {
      const { DatabaseSync } = withoutSqliteExperimentalWarning(() =>
        loadModule<NodeSqliteModule>('node:sqlite')
      );
      db = new DatabaseSync(filePath);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /No such built-in module|Cannot find module|ERR_UNKNOWN_BUILTIN_MODULE/.test(
        `${(error as { code?: string }).code ?? ''} ${error.message}`
      )
    ) {
      throw new SqliteUnavailableError(error);
    }
    throw error;
  }
  const statements = new Map<string, Statement>();
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      let statement = statements.get(sql);
      if (!statement) {
        statement = wrapStatement(db.prepare(sql));
        statements.set(sql, statement);
      }
      return statement;
    },
    close() {
      statements.clear();
      db.close();
    },
  };
}
