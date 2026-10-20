/**
 * Native concurrency locks (`experimental_lock()`) for the Local World: a
 * per-key counter with a FIFO waitlist and direct handoff (stage 2, the
 * contract in `@workflow/world`'s `locks.ts`), or polling waiters with
 * `WORKFLOW_LOCKS_FIFO=0` (stage 1).
 *
 * Layout under the data directory:
 *
 * - `locks/keys/<sha256(key)>[.tag].json`: the key's semaphore, holder and
 *   waiter rows included. The rows live in the same file as the counters, and
 *   every write recomputes `count`, `queuedCount` and `reservedCount` from
 *   them, so the counter invariants hold by construction and every decrement
 *   is the delete of a specific row. Every write holds the key lock, so the
 *   release-vs-enqueue race the contract conditions against cannot occur.
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
  getLockWaitlistPolicy,
  type Lock,
  type LockAttempt,
  type LockHandoff,
  type LockHolder,
  LockHolderSchema,
  LockSchema,
  type LockWaiter,
  LockWaiterSchema,
  type LockWaitlistPolicy,
  type LockWakeTarget,
  lockBackstopAt,
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
    /** Stage 2. Absent on a file written before the waitlist existed. */
    waiters: z.record(z.string(), LockWaiterSchema).optional(),
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
    /** Stage 2: the scope's `lock_failed` (waitlist full). Terminal. */
    failedEventId: z.string().optional(),
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

const waitersOf = (state: LockState) => Object.values(state.waiters ?? {});
const bySeq = (a: LockWaiter, b: LockWaiter) => a.seq - b.seq;
const queuedOf = (state: LockState) =>
  waitersOf(state)
    .filter((w) => !w.grantedAt)
    .sort(bySeq);
const reservedOf = (state: LockState) =>
  waitersOf(state)
    .filter((w) => w.grantedAt)
    .sort(bySeq);
/** `count`: holders plus reserved slots. */
const slotsTaken = (state: LockState) =>
  Object.keys(state.holders).length + reservedOf(state).length;

/** The counters, derived from the rows they count. */
function withCounters(state: LockState): LockState {
  const waiters = waitersOf(state);
  return {
    ...state,
    count: slotsTaken(state),
    ...(state.waiters && {
      queuedCount: waiters.filter((w) => !w.grantedAt).length,
      reservedCount: waiters.filter((w) => w.grantedAt).length,
      tailSeq: state.tailSeq ?? 0,
    }),
  };
}

/**
 * Reserve the slot one removal just freed for the head of the queue, if
 * anyone is queued (contract: Handoff). Returns the grantee.
 */
function handOff(state: LockState, now: Date): LockHandoff | null {
  const head = queuedOf(state)[0];
  if (!head) return null;
  head.grantedAt = now;
  return {
    key: state.key,
    runId: head.runId,
    correlationId: head.correlationId,
    grantedAt: now,
    ...(head.wake && { wake: head.wake }),
  };
}

/**
 * Grant grace: move every stale reservation other than `callerId`'s on to the
 * head of the queue, oldest first, while anyone is queued. The slow grantee
 * goes back to the tail.
 */
function expireStaleGrants(
  state: LockState,
  now: Date,
  policy: LockWaitlistPolicy,
  callerId: string | undefined,
  handoffs: LockHandoff[]
): boolean {
  let changed = false;
  for (const stale of reservedOf(state)) {
    if (holderId(stale.runId, stale.correlationId) === callerId) continue;
    if ((stale.grantedAt as Date).getTime() + policy.graceMs > now.getTime()) {
      continue;
    }
    const next = handOff(state, now);
    if (!next) break;
    handoffs.push(next);
    stale.grantedAt = undefined;
    state.tailSeq = (state.tailSeq ?? 0) + 1;
    stale.seq = state.tailSeq;
    changed = true;
  }
  return changed;
}

/** Remove a scope's holder or waiter row, handing its slot off if it had one. */
function removeRow(
  state: LockState,
  id: string,
  now: Date,
  handoffs: LockHandoff[]
): boolean {
  if (state.holders[id]) {
    delete state.holders[id];
  } else if (state.waiters?.[id]) {
    const waiter = state.waiters[id];
    delete state.waiters[id];
    if (!waiter.grantedAt) return true;
  } else {
    return false;
  }
  const next = handOff(state, now);
  if (next) handoffs.push(next);
  return true;
}

async function writeState(
  basedir: string,
  state: LockState,
  tag?: string
): Promise<void> {
  const next = withCounters(state);
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
  const { holders: _holders, waiters: _waiters, ...lock } = withCounters(state);
  return lock;
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

/** A lock write's result, as `events.create` returns it. */
export interface LockWriteResult {
  event: Event;
  lock: LockAttempt;
  lockHandoffs?: LockHandoff[];
}

type LockCreatedRequest = {
  eventType: 'lock_created';
  correlationId: string;
  eventData: {
    key: string;
    concurrency: number;
    leaseTtlMs?: number;
    wake?: LockWakeTarget;
  };
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
  state: LockState,
  handoffs: LockHandoff[]
): Promise<boolean> {
  let changed = false;
  const nowMs = ctx.now.getTime();
  for (const [id, holder] of Object.entries(state.holders)) {
    if (holder.leaseExpiresAt && holder.leaseExpiresAt.getTime() <= nowMs) {
      changed = removeRow(state, id, ctx.now, handoffs) || changed;
    }
  }
  if (slotsTaken(state) < state.concurrency) return changed;
  // Rows that take a slot (holders and reservations) whose run ended
  // without its reclaim finishing.
  const slotRows = [
    ...Object.entries(state.holders).map(([id, row]) => [id, row.runId]),
    ...reservedOf(state).map((w) => [
      holderId(w.runId, w.correlationId),
      w.runId,
    ]),
  ];
  for (const [id, rowRunId] of slotRows) {
    if (await isRunTerminalCommitted(ctx.basedir, rowRunId, ctx.tag)) {
      changed = removeRow(state, id, ctx.now, handoffs) || changed;
    }
  }
  return changed;
}

export async function createLockAcquisition(
  outer: LockEventContext,
  data: LockCreatedRequest
): Promise<LockWriteResult> {
  const { basedir, tag, runId } = outer;
  const { key, concurrency, leaseTtlMs, wake } = data.eventData;
  const correlationId = data.correlationId;
  const id = holderId(runId, correlationId);
  const policy = getLockWaitlistPolicy();

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
    // Converged: the scope withdrew while it waited (its lock_released left
    // the queue). A later re-POST must not queue or grant it again: nothing
    // would ever release that slot.
    if (scope?.releasedEventId) {
      return {
        event: await requireEvent(
          ctx,
          scope.createdEventId ?? scope.releasedEventId
        ),
        lock: { key, status: 'released', concurrency: state.concurrency },
      };
    }
    // Converged: the scope was refused for good.
    if (scope?.failedEventId) {
      return {
        event: await requireEvent(ctx, scope.failedEventId),
        lock: {
          key,
          status: 'failed',
          reason: 'waitlist_full',
          concurrency: state.concurrency,
        },
      };
    }

    const handoffs: LockHandoff[] = [];
    // The caller's own reservation is not a handoff: it claims it in this
    // same write, or learns of it from its own result.
    const withHandoffs = (result: LockWriteResult): LockWriteResult => {
      const others = handoffs.filter(
        (h) => h.runId !== runId || h.correlationId !== correlationId
      );
      return others.length > 0 ? { ...result, lockHandoffs: others } : result;
    };

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

    let changed = await pruneHolders(ctx, state, handoffs);
    changed =
      expireStaleGrants(state, ctx.now, policy, id, handoffs) || changed;
    // First writer wins on concurrency; a key nobody holds or waits on
    // adopts the request's value.
    if (
      Object.keys(state.holders).length === 0 &&
      waitersOf(state).length === 0
    ) {
      state = { ...state, concurrency };
    }

    const grant = async (fromWaiter: boolean): Promise<LockWriteResult> => {
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
      if (fromWaiter && state.waiters) {
        const { [id]: _claimed, ...waiters } = state.waiters;
        state.waiters = waiters;
      }
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
        { ...(scope as LockScope), acquiredEventId: stored.eventId },
        tag
      );
      return withHandoffs({
        event: stored,
        lock: {
          key,
          status: 'held',
          fencingToken: holder.fencingToken,
          concurrency: state.concurrency,
        },
      });
    };

    const own = state.waiters?.[id];
    // Claim: the scope's reserved slot, however late it came for it.
    if (own?.grantedAt) return grant(true);
    // Grant: a free slot nobody is queued for. Never admits past a queue.
    if (!own && slotsTaken(state) < state.concurrency && !queuedOf(state)[0]) {
      return grant(false);
    }

    const pending = async (lock: LockAttempt): Promise<LockWriteResult> => {
      if (changed) {
        await writeState(basedir, { ...state, updatedAt: ctx.now }, tag);
      }
      if (scope?.createdEventId) {
        return withHandoffs({
          event: await requireEvent(ctx, scope.createdEventId),
          lock,
        });
      }
      const stored = await ctx.storeEvent({
        eventType: 'lock_created',
        correlationId,
        runId,
        eventId: await ctx.mintEventId(),
        createdAt: ctx.now,
        specVersion: ctx.specVersion,
        eventData: {
          key,
          concurrency,
          ...(leaseTtlMs !== undefined && { leaseTtlMs }),
          ...(lock.retryAt && { retryAt: lock.retryAt }),
          ...(wake && { wake }),
        },
      } as Event);
      await writeScope(
        basedir,
        { ...(scope as LockScope), createdEventId: stored.eventId },
        tag
      );
      return withHandoffs({ event: stored, lock });
    };

    if (!policy.fifo && !own) {
      // Stage 1: the scope's deterministic polling schedule. Every attempt
      // in this window gets the same instant, so the runtime's retry
      // messages collapse onto one.
      return pending({
        key,
        status: 'pending',
        retryAt: new Date(
          lockRetryAt(
            `${runId}:${correlationId}`,
            scope.requestedAt.getTime(),
            ctx.now.getTime()
          )
        ),
        concurrency: state.concurrency,
      });
    }

    let waiter = own;
    if (!waiter) {
      // Refused past the cap: journaled, so the workflow's catch of
      // LockWaitlistFullError replays deterministically.
      if (waitersOf(state).length >= policy.waitlistCap) {
        if (changed) {
          await writeState(basedir, { ...state, updatedAt: ctx.now }, tag);
        }
        const stored = await ctx.storeEvent({
          eventType: 'lock_failed',
          correlationId,
          runId,
          eventId: await ctx.mintEventId(),
          createdAt: ctx.now,
          specVersion: ctx.specVersion,
          eventData: {
            key,
            concurrency,
            reason: 'waitlist_full',
            waitlistCap: policy.waitlistCap,
          },
        } as Event);
        await writeScope(
          basedir,
          { ...scope, failedEventId: stored.eventId },
          tag
        );
        return withHandoffs({
          event: stored,
          lock: {
            key,
            status: 'failed',
            reason: 'waitlist_full',
            concurrency: state.concurrency,
          },
        });
      }
      // Enqueue at the tail.
      state.tailSeq = (state.tailSeq ?? 0) + 1;
      waiter = {
        key,
        seq: state.tailSeq,
        runId,
        correlationId,
        enqueuedAt: ctx.now,
        ...(wake && { wake }),
      };
      state.waiters = { ...(state.waiters ?? {}), [id]: waiter };
      changed = true;
    }
    return pending({
      key,
      status: 'pending',
      waiter: 'queued',
      retryAt: new Date(
        lockBackstopAt(
          `${runId}:${correlationId}`,
          waiter.enqueuedAt.getTime(),
          ctx.now.getTime(),
          policy.backstopMs
        )
      ),
      concurrency: state.concurrency,
    });
  });
}

export async function createLockRelease(
  outer: LockEventContext,
  data: LockReleasedRequest
): Promise<LockWriteResult> {
  const { basedir, tag, runId } = outer;
  const { key } = data.eventData;
  const correlationId = data.correlationId;
  const policy = getLockWaitlistPolicy();
  return withKeyLock(basedir, key, tag, async () => {
    const ctx: LockEventContext = { ...outer, now: new Date() };
    const scope = await readScope(basedir, runId, correlationId, tag);
    const state = await readState(basedir, key, tag);
    const id = holderId(runId, correlationId);
    // A scope that holds its slot, or (stage 2) one still waiting for it.
    const waiting = !scope?.acquiredEventId && !!state?.waiters?.[id];
    if ((!scope?.acquiredEventId && !waiting) || scope?.key !== key) {
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
    const handoffs: LockHandoff[] = [];
    if (state) {
      let changed = removeRow(state, id, ctx.now, handoffs);
      changed =
        expireStaleGrants(state, ctx.now, policy, undefined, handoffs) ||
        changed;
      if (changed) {
        await writeState(basedir, { ...state, updatedAt: ctx.now }, tag);
      }
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
    return {
      event: stored,
      lock: { key, status: 'released' },
      ...(handoffs.length > 0 && { lockHandoffs: handoffs }),
    };
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
 * Terminal reclaim: delete every holder and waiter row the run still has,
 * each in the same key-locked write that recomputes its key's counters, and
 * hand each freed slot to its key's queue. Called after the run-terminal
 * marker is published. Returns the handoffs, for the terminal event's result.
 */
export async function reclaimRunLocks(
  basedir: string,
  runId: string,
  tag?: string
): Promise<LockHandoff[]> {
  const scopes = await listRunScopes(basedir, runId, tag);
  const keys = [...new Set(scopes.map((scope) => scope.key))].sort();
  const handoffs: LockHandoff[] = [];
  for (const key of keys) {
    await withKeyLock(basedir, key, tag, async () => {
      const state = await readState(basedir, key, tag);
      if (!state) return;
      const now = new Date();
      const ids = [
        ...Object.entries(state.holders)
          .filter(([, holder]) => holder.runId === runId)
          .map(([id]) => id),
        ...Object.entries(state.waiters ?? {})
          .filter(([, waiter]) => waiter.runId === runId)
          .map(([id]) => id),
      ];
      if (ids.length === 0) return;
      for (const id of ids) removeRow(state, id, now, handoffs);
      await writeState(basedir, { ...state, updatedAt: now }, tag);
    });
  }
  // A slot freed here can land on another of this run's own rows before the
  // loop removes it, which frees it again; drop those intermediate handoffs.
  return handoffs.filter((h) => h.runId !== runId);
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
    async listWaiters({ key, limit }) {
      const state = await readState(basedir, key, tag);
      if (!state) return [];
      const waiters = waitersOf(state).sort(bySeq);
      return limit === undefined ? waiters : waiters.slice(0, limit);
    },
    async releaseHolder({ runId, correlationId }) {
      const scope = await readScope(basedir, runId, correlationId, tag);
      if (!scope) return { released: false };
      return withKeyLock(basedir, scope.key, tag, async () => {
        const state = await readState(basedir, scope.key, tag);
        const id = holderId(runId, correlationId);
        if (!state?.holders[id]) return { released: false };
        // The freed slot goes to the queue's head. Nobody wakes it here: an
        // admin release has no runtime to send the wake, so the grantee
        // claims at its backstop.
        removeRow(state, id, new Date(), []);
        await writeState(basedir, { ...state, updatedAt: new Date() }, tag);
        return { released: true };
      });
    },
  };
}
