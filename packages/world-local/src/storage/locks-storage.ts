/**
 * Native concurrency locks (`experimental_lock()`) for the Local World, stage 1: a per-key
 * counter with polling waiters (no waitlist).
 *
 * Layout under the data directory:
 *
 * - `locks/keys/<sha256(key)>[.tag].json`: the key's semaphore, holder rows
 *   included. Holders live in the same file as `count`, and every write
 *   recomputes `count` from them, so `count == live holder rows` holds by
 *   construction and every decrement is the delete of a specific row.
 * - `locks/scopes/<runId>/<correlationId>[.tag].json`: one record per lock
 *   scope, naming its key and the events it committed. It is the idempotency
 *   record for re-POSTs, and the per-run index the terminal reclaim walks.
 *
 * Every read-modify-write of a key runs under the key's lock: an in-process
 * mutex (on `globalThis`, so every bundled copy of this module shares it)
 * followed by a `proper-lockfile` lock for processes sharing the directory.
 *
 * Terminal reclaim against a racing grant. The run's terminal transition
 * publishes the run-terminal marker, then walks the run's scope records and
 * deletes their holder rows. A grant, inside the key lock, writes its scope
 * record first and only then checks the marker. So either the grant's record
 * exists before the walk lists it (and the walk waits on the key lock and
 * deletes the row the grant inserted), or the grant's check runs after the
 * marker was published and refuses.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import {
  type Event,
  type Lock,
  type LockAttempt,
  type LockHolder,
  LockHolderSchema,
  LockSchema,
  lockRetryAt,
  type Storage,
} from '@workflow/world';
import { lock as lockFile } from 'proper-lockfile';
import { z } from 'zod';
import {
  hasTag,
  isUntagged,
  listJSONFiles,
  readJSON,
  resolveWithinBase,
  taggedPath,
  writeJSON,
} from '../fs.js';
import { isRunTerminalCommitted } from './helpers.js';

const LockStateSchema = z.compile(
  LockSchema.extend({
    holders: z.record(z.string(), LockHolderSchema),
  })
);
type LockState = z.infer<typeof LockStateSchema>;

const LockScopeSchema = z.compile(
  z.object({
    key: z.string(),
    runId: z.string(),
    correlationId: z.string(),
    /** When the scope first asked for a slot; the backoff is derived from it. */
    requestedAt: z.coerce.date(),
    createdEventId: z.string().optional(),
    acquiredEventId: z.string().optional(),
    releasedEventId: z.string().optional(),
  })
);
type LockScope = z.infer<typeof LockScopeSchema>;

const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');

const holderId = (runId: string, correlationId: string) =>
  `${runId}/${correlationId}`;

function keyStatePath(basedir: string, key: string, tag?: string) {
  return taggedPath(basedir, path.join('locks', 'keys'), keyHash(key), tag);
}

function scopeDir(runId: string) {
  return path.join('locks', 'scopes', runId);
}

function scopePath(
  basedir: string,
  runId: string,
  correlationId: string,
  tag?: string
) {
  return taggedPath(basedir, scopeDir(runId), correlationId, tag);
}

function keyLockTarget(basedir: string, key: string, tag?: string) {
  const name = tag ? `${keyHash(key)}.${tag}` : keyHash(key);
  return resolveWithinBase(basedir, '.locks', 'lock-keys', name);
}

/**
 * Per-key in-process mutex chain. On `globalThis` because a bundler can load
 * several copies of this module into one process, and a per-copy chain would
 * not exclude anything.
 */
const keyLocks = globalSingleton(
  '@workflow/world-local//lockKeyMutex',
  1,
  () => ({ byPath: new Map<string, Promise<unknown>>() })
);

async function withKeyLock<T>(
  basedir: string,
  key: string,
  tag: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const target = keyLockTarget(basedir, key, tag);
  const prev = keyLocks.byPath.get(target);
  const box: { task?: Promise<T> } = {};
  const task = (async () => {
    if (prev) await prev.catch(() => undefined);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      let release: () => Promise<void>;
      try {
        release = await lockFile(target, {
          realpath: false,
          stale: 30_000,
          update: 1_000,
          retries: { retries: 600, factor: 1, minTimeout: 50, maxTimeout: 50 },
        });
      } catch (error) {
        throw new WorkflowWorldError(`Could not lock key "${key}"`, {
          cause: error,
          status: 503,
        });
      }
      try {
        return await fn();
      } finally {
        await release().catch(() => {});
      }
    } finally {
      if (keyLocks.byPath.get(target) === box.task) {
        keyLocks.byPath.delete(target);
      }
    }
  })();
  box.task = task;
  keyLocks.byPath.set(target, task);
  return task;
}

async function readState(
  basedir: string,
  key: string,
  tag?: string
): Promise<LockState | null> {
  return readJSON(keyStatePath(basedir, key, tag), LockStateSchema);
}

async function writeState(
  basedir: string,
  state: LockState,
  tag?: string
): Promise<void> {
  // `count` is derived from the rows it counts, on every write.
  const next: LockState = {
    ...state,
    count: Object.keys(state.holders).length,
  };
  await writeJSON(keyStatePath(basedir, state.key, tag), next, {
    overwrite: true,
  });
}

async function readScope(
  basedir: string,
  runId: string,
  correlationId: string,
  tag?: string
): Promise<LockScope | null> {
  return readJSON(
    scopePath(basedir, runId, correlationId, tag),
    LockScopeSchema
  );
}

async function writeScope(
  basedir: string,
  scope: LockScope,
  tag?: string
): Promise<void> {
  await writeJSON(
    scopePath(basedir, scope.runId, scope.correlationId, tag),
    scope,
    { overwrite: true }
  );
}

function toLock(state: LockState): Lock {
  const { holders: _holders, ...lock } = state;
  return { ...lock, count: Object.keys(state.holders).length };
}

/** What a lock event handler needs from the events storage that calls it. */
export interface LockEventContext {
  basedir: string;
  tag?: string;
  runId: string;
  now: Date;
  specVersion: number;
  /** Publishes an event at the next free slot and returns it as stored. */
  storeEvent: (event: Event) => Promise<Event>;
  /** Draws a candidate id for an event this handler is about to publish. */
  mintEventId: () => Promise<string>;
  readEvent: (eventId: string) => Promise<Event | null>;
}

type LockCreatedRequest = {
  eventType: 'lock_created';
  correlationId: string;
  eventData: { key: string; concurrency: number; leaseTtlMs?: number };
};
type LockReleasedRequest = {
  eventType: 'lock_released';
  correlationId: string;
  eventData: { key: string };
};

async function requireEvent(
  ctx: LockEventContext,
  eventId: string
): Promise<Event> {
  const event = await ctx.readEvent(eventId);
  if (!event) {
    throw new WorkflowWorldError(
      `Lock event "${eventId}" for run "${ctx.runId}" is missing`,
      { status: 500 }
    );
  }
  return event;
}

function acquiredEvent(
  ctx: LockEventContext,
  eventId: string,
  data: LockCreatedRequest,
  state: LockState,
  holder: LockHolder
): Event {
  return {
    eventType: 'lock_acquired',
    correlationId: data.correlationId,
    runId: ctx.runId,
    eventId,
    createdAt: ctx.now,
    specVersion: ctx.specVersion,
    eventData: {
      key: data.eventData.key,
      concurrency: data.eventData.concurrency,
      effectiveConcurrency: state.concurrency,
      fencingToken: holder.fencingToken,
      ...(data.eventData.leaseTtlMs !== undefined && {
        leaseTtlMs: data.eventData.leaseTtlMs,
      }),
      ...(holder.leaseExpiresAt && { leaseExpiresAt: holder.leaseExpiresAt }),
    },
  } as Event;
}

/**
 * Prune rows that no longer hold a slot: expired opt-in leases always, and
 * (only when the key is full, since it costs a stat per row) rows whose run's
 * terminal transition committed but whose reclaim never finished.
 */
async function pruneHolders(
  ctx: LockEventContext,
  state: LockState
): Promise<void> {
  const nowMs = ctx.now.getTime();
  for (const [id, holder] of Object.entries(state.holders)) {
    if (holder.leaseExpiresAt && holder.leaseExpiresAt.getTime() <= nowMs) {
      delete state.holders[id];
    }
  }
  if (Object.keys(state.holders).length < state.concurrency) return;
  for (const [id, holder] of Object.entries(state.holders)) {
    if (await isRunTerminalCommitted(ctx.basedir, holder.runId, ctx.tag)) {
      delete state.holders[id];
    }
  }
}

export async function createLockAcquisition(
  outer: LockEventContext,
  data: LockCreatedRequest
): Promise<{ event: Event; lock: LockAttempt }> {
  const { basedir, tag, runId } = outer;
  const { key, concurrency, leaseTtlMs } = data.eventData;
  const correlationId = data.correlationId;
  const id = holderId(runId, correlationId);

  return withKeyLock(basedir, key, tag, async () => {
    // Stamp inside the key lock, so a grant's events and lease are timed
    // after the release that made room for it, never before.
    const ctx: LockEventContext = { ...outer, now: new Date() };
    let state: LockState = (await readState(basedir, key, tag)) ?? {
      key,
      concurrency,
      count: 0,
      grantSeq: 0,
      holders: {},
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    let scope = await readScope(basedir, runId, correlationId, tag);
    if (scope && scope.key !== key) {
      throw new WorkflowWorldError(
        `Lock scope "${correlationId}" was created for key "${scope.key}", not "${key}"`,
        { status: 409 }
      );
    }

    // Converged: the scope already holds (or held) its slot.
    if (scope?.acquiredEventId) {
      const event = await requireEvent(ctx, scope.acquiredEventId);
      const fencingToken = (event as { eventData: { fencingToken: number } })
        .eventData.fencingToken;
      return {
        event,
        lock: {
          key,
          status: scope.releasedEventId ? 'released' : 'held',
          fencingToken,
          concurrency: state.concurrency,
        },
      };
    }

    // A grant whose state write landed but whose event did not (a crash in
    // between): finish it with the token it was granted.
    const existing = state.holders[id];
    if (existing) {
      const stored = await ctx.storeEvent(
        acquiredEvent(ctx, await ctx.mintEventId(), data, state, existing)
      );
      await writeScope(
        basedir,
        {
          ...(scope ?? { key, runId, correlationId, requestedAt: ctx.now }),
          acquiredEventId: stored.eventId,
        },
        tag
      );
      return {
        event: stored,
        lock: {
          key,
          status: 'held',
          fencingToken: existing.fencingToken,
          concurrency: state.concurrency,
        },
      };
    }

    // The scope record goes down before the terminal check: it is what the
    // run's terminal reclaim walks (see the module comment).
    if (!scope) {
      scope = { key, runId, correlationId, requestedAt: ctx.now };
      await writeScope(basedir, scope, tag);
    }
    if (await isRunTerminalCommitted(basedir, runId, tag)) {
      throw new EntityConflictError(
        `Cannot acquire lock "${key}" for run "${runId}" in a terminal state`
      );
    }

    await pruneHolders(ctx, state);
    // First writer wins on concurrency; a key nobody holds adopts the
    // request's value.
    if (Object.keys(state.holders).length === 0) {
      state = { ...state, concurrency };
    }

    if (Object.keys(state.holders).length < state.concurrency) {
      const holder: LockHolder = {
        key,
        runId,
        correlationId,
        fencingToken: state.grantSeq + 1,
        acquiredAt: ctx.now,
        ...(leaseTtlMs !== undefined && {
          leaseExpiresAt: new Date(ctx.now.getTime() + leaseTtlMs),
        }),
      };
      state = {
        ...state,
        grantSeq: holder.fencingToken,
        holders: { ...state.holders, [id]: holder },
        updatedAt: ctx.now,
      };
      await writeState(basedir, state, tag);
      const stored = await ctx.storeEvent(
        acquiredEvent(ctx, await ctx.mintEventId(), data, state, holder)
      );
      await writeScope(
        basedir,
        { ...scope, acquiredEventId: stored.eventId },
        tag
      );
      return {
        event: stored,
        lock: {
          key,
          status: 'held',
          fencingToken: holder.fencingToken,
          concurrency: state.concurrency,
        },
      };
    }

    // Refused. Persist pruning only if it changed something; a plain failed
    // attempt writes nothing.
    if (Object.keys(state.holders).length !== state.count) {
      await writeState(basedir, { ...state, updatedAt: ctx.now }, tag);
    }
    // The scope's deterministic schedule: every attempt in this window gets
    // the same instant, so the runtime's retry messages collapse onto one.
    const retryAt = new Date(
      lockRetryAt(
        `${runId}:${correlationId}`,
        scope.requestedAt.getTime(),
        ctx.now.getTime()
      )
    );
    const lock: LockAttempt = {
      key,
      status: 'pending',
      retryAt,
      concurrency: state.concurrency,
    };
    if (scope.createdEventId) {
      return { event: await requireEvent(ctx, scope.createdEventId), lock };
    }
    const stored = await ctx.storeEvent({
      eventType: 'lock_created',
      correlationId,
      runId,
      eventId: await ctx.mintEventId(),
      createdAt: ctx.now,
      specVersion: ctx.specVersion,
      eventData: { ...data.eventData, retryAt },
    } as Event);
    await writeScope(
      basedir,
      { ...scope, createdEventId: stored.eventId },
      tag
    );
    return { event: stored, lock };
  });
}

export async function createLockRelease(
  outer: LockEventContext,
  data: LockReleasedRequest
): Promise<{ event: Event; lock: LockAttempt }> {
  const { basedir, tag, runId } = outer;
  const { key } = data.eventData;
  const correlationId = data.correlationId;
  return withKeyLock(basedir, key, tag, async () => {
    const ctx: LockEventContext = { ...outer, now: new Date() };
    const scope = await readScope(basedir, runId, correlationId, tag);
    if (!scope?.acquiredEventId || scope.key !== key) {
      throw new EntityConflictError(
        `Lock scope "${correlationId}" does not hold "${key}"`
      );
    }
    if (scope.releasedEventId) {
      throw new EntityConflictError(
        `Lock scope "${correlationId}" already released "${key}"`
      );
    }
    if (await isRunTerminalCommitted(basedir, runId, tag)) {
      throw new EntityConflictError(
        `Cannot release lock "${key}" for run "${runId}" in a terminal state`
      );
    }
    const state = await readState(basedir, key, tag);
    const id = holderId(runId, correlationId);
    if (state?.holders[id]) {
      const { [id]: _released, ...holders } = state.holders;
      await writeState(basedir, { ...state, holders, updatedAt: ctx.now }, tag);
    }
    const stored = await ctx.storeEvent({
      eventType: 'lock_released',
      correlationId,
      runId,
      eventId: await ctx.mintEventId(),
      createdAt: ctx.now,
      specVersion: ctx.specVersion,
      eventData: { key },
    } as Event);
    await writeScope(
      basedir,
      { ...scope, releasedEventId: stored.eventId },
      tag
    );
    return { event: stored, lock: { key, status: 'released' } };
  });
}

async function listRunScopes(
  basedir: string,
  runId: string,
  tag?: string
): Promise<LockScope[]> {
  const dir = resolveWithinBase(basedir, scopeDir(runId));
  const files = (await listJSONFiles(dir)).filter((f) =>
    tag ? hasTag(f, tag) : isUntagged(f)
  );
  const scopes: LockScope[] = [];
  for (const file of files) {
    const scope = await readJSON(
      path.join(dir, `${file}.json`),
      LockScopeSchema
    );
    if (scope) scopes.push(scope);
  }
  return scopes;
}

/**
 * Terminal reclaim: delete every holder row the run still has, each in the
 * same key-locked write that recomputes its key's count. Called after the
 * run-terminal marker is published.
 */
export async function reclaimRunLocks(
  basedir: string,
  runId: string,
  tag?: string
): Promise<void> {
  const scopes = await listRunScopes(basedir, runId, tag);
  const keys = [...new Set(scopes.map((scope) => scope.key))].sort();
  for (const key of keys) {
    await withKeyLock(basedir, key, tag, async () => {
      const state = await readState(basedir, key, tag);
      if (!state) return;
      const holders = Object.fromEntries(
        Object.entries(state.holders).filter(
          ([, holder]) => holder.runId !== runId
        )
      );
      if (Object.keys(holders).length === Object.keys(state.holders).length) {
        return;
      }
      await writeState(
        basedir,
        { ...state, holders, updatedAt: new Date() },
        tag
      );
    });
  }
}

/** The optional `Storage['locks']` namespace for the Local World. */
export function createLocksStorage(
  basedir: string,
  tag?: string
): NonNullable<Storage['locks']> {
  async function allStates(): Promise<LockState[]> {
    const dir = resolveWithinBase(basedir, 'locks', 'keys');
    const files = (await listJSONFiles(dir)).filter((f) =>
      tag ? hasTag(f, tag) : isUntagged(f)
    );
    const states: LockState[] = [];
    for (const file of files) {
      const state = await readJSON(
        path.join(dir, `${file}.json`),
        LockStateSchema
      );
      if (state) states.push(state);
    }
    return states;
  }

  return {
    async get(key) {
      const state = await readState(basedir, key, tag);
      return state ? toLock(state) : null;
    },
    async listHolders({ key, runId }) {
      let states: LockState[];
      if (key !== undefined) {
        const state = await readState(basedir, key, tag);
        states = state ? [state] : [];
      } else if (runId !== undefined) {
        const keys = new Set(
          (await listRunScopes(basedir, runId, tag)).map((s) => s.key)
        );
        states = [];
        for (const k of keys) {
          const state = await readState(basedir, k, tag);
          if (state) states.push(state);
        }
      } else {
        states = await allStates();
      }
      return states
        .flatMap((state) => Object.values(state.holders))
        .filter((holder) => runId === undefined || holder.runId === runId);
    },
    async releaseHolder({ runId, correlationId }) {
      const scope = await readScope(basedir, runId, correlationId, tag);
      if (!scope) return { released: false };
      return withKeyLock(basedir, scope.key, tag, async () => {
        const state = await readState(basedir, scope.key, tag);
        const id = holderId(runId, correlationId);
        if (!state?.holders[id]) return { released: false };
        const { [id]: _released, ...holders } = state.holders;
        await writeState(
          basedir,
          { ...state, holders, updatedAt: new Date() },
          tag
        );
        return { released: true };
      });
    },
  };
}
