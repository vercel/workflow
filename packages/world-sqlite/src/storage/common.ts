import { EventEmitter } from 'node:events';
import { WorkflowWorldError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import type {
  Event,
  Hook,
  PaginatedResponse,
  Step,
  Wait,
  WorkflowRun,
} from '@workflow/world';
import {
  EventSchema,
  envNumber,
  getEventDataRefFields,
  HookSchema,
  StepSchema,
  WaitSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { type Db, decode, encode, type SqlValue, toMillis } from '../db.js';

export const DEFAULT_RESOLVE_DATA_OPTION = 'all';

/** Shared state for one storage instance: its connection and its tag. */
export interface Ctx {
  db: Db;
  /** `''` when untagged. */
  tag: string;
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

const ulids = globalSingleton(
  '@workflow/world-sqlite//monotonicUlid',
  1,
  () => ({
    next: monotonicFactory(),
  })
);

export const monotonicUlid = (seedTime?: number): string =>
  ulids.next(seedTime);

function truncateForError(value: string): string {
  const MAX = 48;
  return value.length > MAX ? `${value.slice(0, MAX)}…` : value;
}

/**
 * Thrown for an id world-local would refuse as a path segment. SQLite needs
 * no such restriction, but rejecting the same ids keeps the two worlds
 * interchangeable and keeps request-derived ids sane.
 */
export class UnsafeEntityIdError extends WorkflowWorldError {
  constructor(kind: string, value: string) {
    super(
      `Unsafe ${kind} "${truncateForError(value)}": must not be empty, contain ".", "/", "\\", or null bytes`
    );
    this.name = 'UnsafeEntityIdError';
  }

  static is(value: unknown): value is UnsafeEntityIdError {
    return value instanceof Error && value.name === 'UnsafeEntityIdError';
  }
}

export function assertSafeEntityId(kind: string, value: string): void {
  if (
    value.length === 0 ||
    value.startsWith('.') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('.')
  ) {
    throw new UnsafeEntityIdError(kind, value);
  }
}

// ---------------------------------------------------------------------------
// Row (de)serialization
// ---------------------------------------------------------------------------

/**
 * Zod schema for reading persisted events. Payload ref fields absent from a
 * stored row (purged by retention, or never written) are restored as
 * explicit `undefined` so callers see the same shape world-local returns.
 */
export const ReadEventSchema: z.ZodType<Event> = z.preprocess((raw) => {
  if (
    raw &&
    typeof raw === 'object' &&
    'eventType' in raw &&
    'eventData' in raw
  ) {
    const eventData = (raw as { eventData: unknown }).eventData;
    if (eventData && typeof eventData === 'object') {
      for (const field of getEventDataRefFields(
        String((raw as { eventType: unknown }).eventType)
      )) {
        if (!(field in eventData)) {
          (eventData as Record<string, unknown>)[field] = undefined;
        }
      }
    }
  }
  return raw;
}, EventSchema) as unknown as z.ZodType<Event>;

export function parseRun(data: SqlValue): WorkflowRun {
  return WorkflowRunSchema.parse(decode(data)) as WorkflowRun;
}

export function parseEvent(data: SqlValue): Event {
  return ReadEventSchema.parse(decode(data));
}

export function parseHook(data: SqlValue): Hook {
  return HookSchema.parse(decode(data)) as Hook;
}

export function parseWait(data: SqlValue): Wait {
  return WaitSchema.parse(decode(data)) as Wait;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** The run, preferring this instance's tag and falling back to untagged. */
export function readRun(ctx: Ctx, runId: string): WorkflowRun | null {
  const row = ctx.db.get<{ data: Uint8Array }>(
    'SELECT data FROM runs WHERE run_id = ? AND tag IN (?, ?)',
    runId,
    ctx.tag,
    ''
  );
  return row ? parseRun(row.data) : null;
}

export function writeRun(ctx: Ctx, run: WorkflowRun): void {
  ctx.db.run(
    `INSERT INTO runs (run_id, tag, status, workflow_name, created_at, data)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id) DO UPDATE SET
       tag = excluded.tag, status = excluded.status,
       workflow_name = excluded.workflow_name, data = excluded.data`,
    run.runId,
    ctx.tag,
    run.status,
    run.workflowName,
    toMillis(run.createdAt),
    encode(run)
  );
}

/** Inserts a new run; false when the id is already taken. */
export function insertRun(ctx: Ctx, run: WorkflowRun): boolean {
  const { changes } = ctx.db.run(
    `INSERT INTO runs (run_id, tag, status, workflow_name, created_at, data)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    run.runId,
    ctx.tag,
    run.status,
    run.workflowName,
    toMillis(run.createdAt),
    encode(run)
  );
  return changes > 0;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * A step row joined with its input. The input is stored once, on the
 * step_created event the row points at (`input_seq`).
 */
function hydrateStep(row: {
  data: Uint8Array;
  event_data: Uint8Array | null;
}): Step {
  const step = decode<Record<string, unknown>>(row.data);
  if (row.event_data) {
    const event = decode<{ eventData?: { input?: unknown } }>(row.event_data);
    step.input = event.eventData?.input;
  }
  return StepSchema.parse(step) as Step;
}

const STEP_SELECT = `SELECT s.data AS data, e.data AS event_data, s.created_at AS created_at, s.step_id AS step_id
  FROM steps s LEFT JOIN events e ON e.run_id = s.run_id AND e.seq = s.input_seq`;

export function readStep(ctx: Ctx, runId: string, stepId: string): Step | null {
  const row = ctx.db.get<{ data: Uint8Array; event_data: Uint8Array | null }>(
    `${STEP_SELECT} WHERE s.run_id = ? AND s.step_id = ? AND s.tag IN (?, ?)`,
    runId,
    stepId,
    ctx.tag,
    ''
  );
  return row ? hydrateStep(row) : null;
}

export function listStepRows(
  ctx: Ctx,
  runId: string
): { step: Step; createdAt: number; id: string }[] {
  return ctx.db
    .all<{
      data: Uint8Array;
      event_data: Uint8Array | null;
      created_at: number;
      step_id: string;
    }>(`${STEP_SELECT} WHERE s.run_id = ?`, runId)
    .map((row) => ({
      step: hydrateStep(row),
      createdAt: Number(row.created_at),
      id: row.step_id,
    }));
}

/**
 * Writes a step. `inputSeq` names the step_created event holding the input;
 * omit it to keep the row's current pointer.
 */
export function writeStep(ctx: Ctx, step: Step, inputSeq?: number): void {
  const { input: _input, ...rest } = step as Step & { input?: unknown };
  ctx.db.run(
    `INSERT INTO steps (run_id, step_id, tag, created_at, input_seq, data)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, step_id) DO UPDATE SET
       tag = excluded.tag, data = excluded.data,
       input_seq = coalesce(excluded.input_seq, steps.input_seq)`,
    step.runId,
    step.stepId,
    ctx.tag,
    toMillis(step.createdAt),
    inputSeq ?? null,
    encode(rest)
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function readHook(ctx: Ctx, hookId: string): Hook | null {
  const row = ctx.db.get<{ data: Uint8Array }>(
    'SELECT data FROM hooks WHERE hook_id = ? AND tag IN (?, ?)',
    hookId,
    ctx.tag,
    ''
  );
  return row ? parseHook(row.data) : null;
}

export function writeHook(ctx: Ctx, hook: Hook): void {
  ctx.db.run(
    `INSERT INTO hooks (hook_id, tag, run_id, token, created_at, data)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (hook_id) DO UPDATE SET
       tag = excluded.tag, run_id = excluded.run_id, token = excluded.token,
       created_at = excluded.created_at, data = excluded.data`,
    hook.hookId,
    ctx.tag,
    hook.runId,
    hook.token,
    toMillis(hook.createdAt),
    encode(hook)
  );
}

export function deleteHookRow(ctx: Ctx, hookId: string): void {
  ctx.db.run('DELETE FROM hooks WHERE hook_id = ?', hookId);
}

export interface HookTokenClaim {
  token: string;
  hookId: string;
  runId: string;
  eventId?: string;
  tokenRetentionUntil?: Date;
  claimedFrom?: {
    runId: string;
    hookId: string;
    deploymentId?: string;
    workflowName?: string;
    specVersion?: number;
  };
}

export function readHookTokenClaim(
  ctx: Ctx,
  token: string
): HookTokenClaim | null {
  const row = ctx.db.get<{ data: Uint8Array }>(
    'SELECT data FROM hook_tokens WHERE token = ?',
    token
  );
  return row ? decode<HookTokenClaim>(row.data) : null;
}

export function writeHookTokenClaim(ctx: Ctx, claim: HookTokenClaim): void {
  ctx.db.run(
    `INSERT INTO hook_tokens (token, run_id, hook_id, event_id, data)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (token) DO UPDATE SET run_id = excluded.run_id,
       hook_id = excluded.hook_id, event_id = excluded.event_id,
       data = excluded.data`,
    claim.token,
    claim.runId,
    claim.hookId,
    claim.eventId ?? '',
    encode(claim)
  );
}

/** Deletes the token claim only while it still belongs to this hook. */
export function releaseHookTokenClaimIfOwnedBy(
  ctx: Ctx,
  token: string,
  owner: { runId: string; hookId: string }
): void {
  ctx.db.run(
    'DELETE FROM hook_tokens WHERE token = ? AND run_id = ? AND hook_id = ?',
    token,
    owner.runId,
    owner.hookId
  );
}

// ---------------------------------------------------------------------------
// Locks (write-once markers)
// ---------------------------------------------------------------------------

/** Claims `name`; false when it was already claimed. */
export function claimLock(ctx: Ctx, name: string, data = ''): boolean {
  const { changes } = ctx.db.run(
    'INSERT INTO locks (name, data) VALUES (?, ?) ON CONFLICT DO NOTHING',
    name,
    data
  );
  return changes > 0;
}

export function readLock(ctx: Ctx, name: string): string | null {
  const row = ctx.db.get<{ data: string }>(
    'SELECT data FROM locks WHERE name = ?',
    name
  );
  return row ? row.data : null;
}

export function releaseLock(ctx: Ctx, name: string): void {
  ctx.db.run('DELETE FROM locks WHERE name = ?', name);
}

export function taggedLockName(name: string, tag: string): string {
  return tag ? `${name}.${tag}` : name;
}

export function hookDisposeLockName(hookId: string, tag?: string): string {
  return taggedLockName(`hooks/${hookId}.disposed`, tag ?? '');
}

export type HookDisposeLock =
  | { committed: false }
  | { committed: true; forceClaimedBy?: { runId: string; hookId: string } };

/** The hook's disposal marker: untagged first, then this instance's tag. */
export function readHookDisposeLock(ctx: Ctx, hookId: string): HookDisposeLock {
  const names = [hookDisposeLockName(hookId)];
  if (ctx.tag) names.push(hookDisposeLockName(hookId, ctx.tag));
  for (const name of names) {
    const content = readLock(ctx, name);
    if (content === null) continue;
    if (content.trim() === '') return { committed: true };
    try {
      const by = (
        JSON.parse(content) as {
          forceClaimedBy?: { runId?: unknown; hookId?: unknown };
        }
      ).forceClaimedBy;
      if (by && typeof by.runId === 'string' && typeof by.hookId === 'string') {
        return {
          committed: true,
          forceClaimedBy: { runId: by.runId, hookId: by.hookId },
        };
      }
    } catch {
      // Unexpected content: still a disposal.
    }
    return { committed: true };
  }
  return { committed: false };
}

export function isHookDisposalCommitted(ctx: Ctx, hookId: string): boolean {
  return readHookDisposeLock(ctx, hookId).committed;
}

// ---------------------------------------------------------------------------
// Waits
// ---------------------------------------------------------------------------

export function readWait(ctx: Ctx, waitId: string): Wait | null {
  const row = ctx.db.get<{ data: Uint8Array }>(
    'SELECT data FROM waits WHERE wait_id = ? AND tag IN (?, ?)',
    waitId,
    ctx.tag,
    ''
  );
  return row ? parseWait(row.data) : null;
}

export function writeWait(ctx: Ctx, wait: Wait): void {
  ctx.db.run(
    `INSERT INTO waits (wait_id, run_id, tag, data) VALUES (?, ?, ?, ?)
     ON CONFLICT (wait_id) DO UPDATE SET tag = excluded.tag, data = excluded.data`,
    wait.waitId,
    wait.runId,
    ctx.tag,
    encode(wait)
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const SORT_KEY_CURSOR_PREFIX = 'key:';

export interface ParsedCursor {
  timestamp: Date;
  id: string | null;
}

/** Parses a `<ISO timestamp>|<id>` cursor, world-local's entity cursor. */
export function parseTimeCursor(
  cursor: string | undefined
): ParsedCursor | null {
  if (!cursor || cursor.startsWith(SORT_KEY_CURSOR_PREFIX)) return null;
  const parts = cursor.split('|');
  return { timestamp: new Date(parts[0]), id: parts[1] || null };
}

export function createTimeCursor(
  timestamp: Date,
  id: string | undefined
): string {
  return id ? `${timestamp.toISOString()}|${id}` : timestamp.toISOString();
}

/**
 * Sorts, cursors and pages already-filtered items the way world-local's
 * `paginatedFileSystemQuery` does: by `createdAt`, ties broken by id, a
 * `<ISO>|<id>` cursor, and `cursor` set whenever the page is non-empty.
 */
export function paginateByCreatedAt<T>(
  items: T[],
  opts: {
    getCreatedAt: (item: T) => Date;
    getId: (item: T) => string;
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    cursor?: string;
  }
): PaginatedResponse<T> {
  const sortOrder = opts.sortOrder ?? 'desc';
  const limit = opts.limit ?? 20;
  const cursor = parseTimeCursor(opts.cursor);
  const dir = sortOrder === 'desc' ? -1 : 1;
  const sorted = [...items].sort((a, b) => {
    const diff =
      opts.getCreatedAt(a).getTime() - opts.getCreatedAt(b).getTime();
    if (diff !== 0) return diff * dir;
    return opts.getId(a).localeCompare(opts.getId(b)) * dir;
  });
  const after = cursor
    ? sorted.filter((item) => {
        const time = opts.getCreatedAt(item).getTime();
        const cursorTime = cursor.timestamp.getTime();
        if (time !== cursorTime) {
          return sortOrder === 'desc' ? time < cursorTime : time > cursorTime;
        }
        if (!cursor.id) return false;
        const cmp = opts.getId(item).localeCompare(cursor.id);
        return sortOrder === 'desc' ? cmp < 0 : cmp > 0;
      })
    : sorted;
  const hasMore = after.length > limit;
  const data = after.slice(0, limit);
  const last = data.at(-1);
  return {
    data,
    cursor: last
      ? createTimeCursor(opts.getCreatedAt(last), opts.getId(last))
      : null,
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// Run terminal signal (in-process wakeups for waitForTerminalStatus)
// ---------------------------------------------------------------------------

const runStatus = globalSingleton(
  '@workflow/world-sqlite//runStatus',
  1,
  () => {
    const emitter = new EventEmitter<{ [key: `run:${string}`]: [] }>();
    emitter.setMaxListeners(0);
    return { emitter };
  }
);

export function getRunStatusPollIntervalMs(): number {
  return envNumber('WORKFLOW_LOCAL_RUN_STATUS_POLL_INTERVAL_MS', 100, {
    integer: true,
    min: 1,
  });
}

export function signalRunTerminal(runId: string): void {
  runStatus.emitter.emit(`run:${runId}`);
}

export function waitForRunTerminalSignal(
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    const key = `run:${runId}` as const;
    const done = () => {
      clearTimeout(timer);
      runStatus.emitter.off(key, done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    runStatus.emitter.once(key, done);
    signal?.addEventListener('abort', done, { once: true });
  });
}
