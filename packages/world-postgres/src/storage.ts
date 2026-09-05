import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  AnyEventRequest,
  AttributeChange,
  CreateEventParams,
  Event,
  EventResult,
  ExperimentalSetAttributesResult,
  GetEventParams,
  Hook,
  ListEventsParams,
  ListHooksParams,
  PaginatedResponse,
  ResolveData,
  SerializedData,
  Step,
  StepWithoutData,
  Storage,
  Wait,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  ATTRIBUTE_MAX_PER_RUN,
  AttributeValidationError,
  EVENT_ID_BODY_LENGTH,
  EVENT_ID_PREFIX,
  EventSchema,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  getMaxEventsPerRun,
  HookSchema,
  isChildEntityCreationEvent,
  isChildEntityCreationEventType,
  isHookEventRequiringExistence,
  isLegacySpecVersion,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
  slotToEventId,
  stripEventDataRefs,
  TERMINAL_STEP_STATUSES,
  TERMINAL_WORKFLOW_RUN_STATUSES,
  validateAttributeChanges,
  validateUlidTimestamp,
  WorkflowRunSchema,
} from '@workflow/world';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import { type Drizzle, Schema } from './drizzle/index.js';
import type { SerializedContent } from './drizzle/schema.js';
import {
  getRunStatusPollIntervalMs,
  notifyRunTerminal,
  type RunStatusListener,
} from './run-status.js';
import { compact } from './util.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A drizzle handle, either the pool or a transaction. Slot allocation runs on
 * whichever one the caller is already inside, so the position an insert takes
 * commits or rolls back with the insert itself.
 */
type DrizzleLike = Pick<Drizzle, 'insert' | 'update' | 'select'>;

/** Only for legacy (pre-slot) runs; see `allocateEventId`. */
const legacyEventUlid = monotonicFactory();

/**
 * How many positions one insert will try before giving up. Reached only when a
 * run is taking concurrent writes faster than any of them can commit.
 */
const SLOT_INSERT_MAX_ATTEMPTS = 40;
/**
 * Collisions that retry the instant the conflicting writer settles.
 *
 * `ON CONFLICT DO NOTHING` does not skip an uncommitted conflicting row: the
 * unique-index check waits on that writer's transaction and only then reports
 * the conflict, so a lost race has already waited for exactly the thing the
 * next position depends on. Sleeping on top of that adds latency to a
 * suspension flush and buys nothing.
 *
 * The backoff below covers the shape blocking does not: writers that keep
 * arriving while the loop spins, where jittering the herd is the only way the
 * loop converges before it exhausts its attempts.
 */
const SLOT_INSERT_IMMEDIATE_ATTEMPTS = 8;
/** Backoff between collisions, so a wide fan-out spreads rather than lockstep. */
const SLOT_INSERT_BASE_DELAY_MS = 2;
const SLOT_INSERT_MAX_DELAY_MS = 40;

/**
 * Isolation for every transaction an event insert can run inside.
 *
 * {@link insertEventRow} answers a collision by recomputing the next position
 * and inserting again, which only terminates if the retry can see rows
 * committed since the transaction began. Under REPEATABLE READ or SERIALIZABLE
 * it cannot: every attempt reads the transaction's original snapshot, computes
 * the same taken position, and the loop runs to its limit and 503s. READ
 * COMMITTED is Postgres' default, so this is a statement of the requirement
 * rather than a change, and it keeps a database whose
 * `default_transaction_isolation` was raised from turning event writes into
 * timeouts. Inserts outside a transaction need nothing: a lone statement takes
 * a fresh snapshot at every isolation level.
 */
const SLOT_INSERT_TRANSACTION = { isolationLevel: 'read committed' } as const;

/** The pg error behind a drizzle wrapper, or an empty shape if there is none. */
function pgErrorOf(err: unknown): { code?: string; constraint?: string } {
  const direct = err as { code?: string; constraint?: string };
  if (direct?.code) {
    return direct;
  }
  return (
    (err as { cause?: { code?: string; constraint?: string } })?.cause ?? {}
  );
}

/**
 * The position a slot-numbered insert takes: one above the highest the run
 * already holds, read inside the INSERT that takes it.
 *
 * Nothing hands out a position ahead of the write that fills it. A writer that
 * loses a dedup race, or whose transaction rolls back, leaves the numbering
 * untouched, so a log missing a position is missing an *event* rather than
 * merely a number. The runtime depends on exactly that: it refuses to replay a
 * log with a hole, because a position nothing occupies cannot be told apart
 * from an event that never happened.
 *
 * A counter column would be cheaper and is what this used to be. It cannot
 * hold that property: a number handed out before the write lands is a number
 * lost whenever the write does not, and the resulting holes are permanent.
 *
 * The subquery is an index-only read of the primary key's last row for the
 * run, not a scan. Ordering is lexicographic, which is the same order as by
 * position because every body is zero-padded to a fixed width.
 *
 * Every numeric parameter is cast explicitly. `substring(text from $n)` with an
 * untyped parameter resolves to the *regular expression* overload rather than
 * the positional one, which quietly returns NULL for every id and hands every
 * writer the first slot.
 */
function nextSlotId(runId: string): SQL<string> {
  const bodyFrom = sql.raw(String(EVENT_ID_PREFIX.length + 1));
  const width = sql.raw(String(EVENT_ID_BODY_LENGTH));
  const noEvents = sql.raw(String(FIRST_EVENT_SLOT - 1));
  return sql<string>`${EVENT_ID_PREFIX} || lpad((coalesce((select cast(substring(prev.id from ${bodyFrom}) as bigint) from ${Schema.events} prev where prev.run_id = ${runId} order by prev.id desc limit 1), ${noEvents}) + 1)::text, ${width}, '0')`;
}

/**
 * The id an insert for `runId` should allocate with: a slot expression for a
 * slot-numbered run, a fresh ULID for one that predates slots.
 *
 * A row in `workflow_event_slots` is the marker for the first case. Its
 * absence is exactly the "this run predates slots" signal, which is why the
 * table is still read even though nothing advances it any more.
 *
 * A legacy run keeps minting under the original `wevt_` prefix rather than
 * moving to `evnt_`: a mid-life prefix change would sort every new event
 * before every old one, since `evnt_` < `wevt_`.
 */
async function allocateEventId(
  db: DrizzleLike,
  runId: string
): Promise<string | SQL<string>> {
  const [row] = await db
    .select({ runId: Schema.eventSlots.runId })
    .from(Schema.eventSlots)
    .where(eq(Schema.eventSlots.runId, runId))
    .limit(1);
  return row ? nextSlotId(runId) : `wevt_${legacyEventUlid()}`;
}

/**
 * Inserts one event row, retrying while the position it computed is taken.
 *
 * The primary-key conflict is absorbed by `ON CONFLICT DO NOTHING` rather than
 * raised, so a lost race costs a retry instead of the enclosing transaction.
 * An error inside a transaction would poison it, and these inserts run in one.
 * Every other unique violation still raises, which is what lets callers
 * translate a dedup conflict on `workflow_events_entity_creation_unique`.
 *
 * Returns `undefined` only for an id that is a plain string (a legacy ULID, or
 * the reserved first slot), where a conflict is the caller's answer rather
 * than something to retry.
 */
async function insertEventRow(
  db: DrizzleLike,
  values: Omit<typeof Schema.events.$inferInsert, 'eventId'> & {
    eventId: string | SQL<string>;
  }
): Promise<{ eventId: string; createdAt: Date } | undefined> {
  const runId = values.runId;
  const allocates = typeof values.eventId !== 'string';
  for (let attempt = 0; ; attempt++) {
    const [row] = await db
      .insert(Schema.events)
      .values(values as typeof Schema.events.$inferInsert)
      .onConflictDoNothing({
        target: [Schema.events.runId, Schema.events.eventId],
      })
      .returning({
        eventId: Schema.events.eventId,
        createdAt: Schema.events.createdAt,
      });
    if (row) {
      return row;
    }
    if (!allocates || attempt >= SLOT_INSERT_MAX_ATTEMPTS) {
      if (!allocates) {
        return undefined;
      }
      throw new WorkflowWorldError(
        `Could not allocate an event slot for run "${runId}" after ${SLOT_INSERT_MAX_ATTEMPTS} attempts`,
        { status: 503 }
      );
    }
    if (attempt >= SLOT_INSERT_IMMEDIATE_ATTEMPTS) {
      const delay = Math.min(
        SLOT_INSERT_MAX_DELAY_MS,
        SLOT_INSERT_BASE_DELAY_MS *
          2 ** (attempt - SLOT_INSERT_IMMEDIATE_ATTEMPTS)
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * delay)
      );
    }
  }
}

/**
 * Marks a run being created as slot-numbered and returns its first event id.
 *
 * The row records the scheme and nothing else; positions come from the log
 * itself, see {@link nextSlotId}.
 *
 * `DO NOTHING` on conflict because the arbitration that matters is the event
 * insert: two writers racing one run_created both take the first slot, and the
 * composite events primary key rejects the loser.
 */
async function openEventSlots(db: DrizzleLike, runId: string): Promise<string> {
  await db.insert(Schema.eventSlots).values({ runId }).onConflictDoNothing();
  return slotToEventId(FIRST_EVENT_SLOT);
}

/**
 * The report half of bump-and-report: the events sitting on the slots between
 * the one the writer asked for and the one its write actually landed on.
 *
 * Returns `undefined` when there is nothing to report: the write took the slot
 * it asked for, the run is not slot-numbered, or the caller sent a count from a
 * log that is already ahead of this write.
 *
 * The set can be short of the slot span it covers. A position is taken by the
 * INSERT that computes it, and that INSERT commits on its own, so at the moment
 * this reads the span a concurrent writer holding a lower position may not have
 * committed yet. Its row appears shortly after and no position is left behind,
 * because a write that fails never took one. `hasMore` says the report is a
 * lower bound for now rather than a permanent one, and it is advisory either
 * way: the caller's ordinary incremental read still runs.
 */
async function reportSkippedSlots(
  db: Drizzle,
  runId: string,
  committedEventId: string,
  askedFor: number,
  resolveData: ResolveData
): Promise<{ events: Event[]; hasMore: boolean } | undefined> {
  const committedSlot = eventIdToSlot(committedEventId);
  if (
    committedSlot === null ||
    askedFor < FIRST_EVENT_SLOT ||
    committedSlot <= askedFor + 1
  ) {
    return undefined;
  }
  const rows = await db
    .select()
    .from(Schema.events)
    .where(
      and(
        eq(Schema.events.runId, runId),
        gt(Schema.events.eventId, slotToEventId(askedFor)),
        lt(Schema.events.eventId, committedEventId)
      )
    )
    .orderBy(Schema.events.eventId);
  const events = rows.map((row) => {
    row.eventData ||= row.eventDataJson;
    return stripEventDataRefs(EventSchema.parse(compact(row)), resolveData);
  });
  return {
    events,
    hasMore: events.length < committedSlot - askedFor - 1,
  };
}

function getHookRetentionLimitMs(): number {
  const days = Number(
    process.env.WORKFLOW_POSTGRES_HOOK_RETENTION_LIMIT_DAYS ?? 30
  );
  if (!Number.isFinite(days) || days <= 0) {
    throw new WorkflowWorldError(
      'WORKFLOW_POSTGRES_HOOK_RETENTION_LIMIT_DAYS must be a positive number',
      { status: 400 }
    );
  }
  return days * DAY_MS;
}

/**
 * Read helper for the deprecated `error` text column (legacy: JSON-stringified
 * `StructuredError`). In the current event-sourced model, the `error` field on
 * entities is `SerializedData` (Uint8Array) produced by the new error
 * serialization pipeline; legacy text-column records pre-date that pipeline
 * and cannot be hydrated back into the original thrown value.
 *
 * Returns `null` unconditionally so downstream consumers treat legacy errors
 * as absent rather than receiving a shape that `hydrateStepError` /
 * `hydrateRunError` can't process. Callers that need to inspect the raw
 * legacy payload should read the `errorJson` column directly.
 */
function parseErrorJson(_errorJson: string | null): SerializedData | null {
  return null;
}

/**
 * Pass-through helper kept for backwards compatibility with the run read path.
 * In the current event-sourced model, `error` is already `SerializedData`
 * (Uint8Array) on the entity, and any legacy `errorStack` / `errorCode`
 * fields are no longer populated by the current write path.
 */
function deserializeRunError(run: any): WorkflowRun {
  // Drop any stale legacy-only fields we might still encounter on read.
  const { errorStack: _errorStack, ...rest } = run;
  return rest as WorkflowRun;
}

/**
 * Deserialize step data, mapping DB columns to interface fields.
 * The error field should already be deserialized from CBOR or fallback to errorJson.
 */
function deserializeStepError(step: any): Step {
  const { startedAt, ...rest } = step;

  return {
    ...rest,
    startedAt,
  } as Step;
}

export function createRunsStorage(
  drizzle: Drizzle,
  /**
   * Shared `LISTEN` subscription used by `waitForTerminalStatus`. Omit it and
   * the wait still works, purely on its backstop re-read, which is what a
   * direct caller constructing storage without a pool gets.
   */
  runStatusListener?: RunStatusListener
): Storage['runs'] {
  const { runs } = Schema;
  const get = drizzle
    .select()
    .from(runs)
    .where(eq(runs.runId, sql.placeholder('id')))
    .limit(1)
    .prepare('workflow_runs_get');

  const getRun = (async (id, params) => {
    const [value] = await get.execute({ id });
    if (!value) {
      throw new WorkflowRunNotFoundError(id);
    }
    value.output ||= value.outputJson;
    value.input ||= value.inputJson;
    value.executionContext ||= value.executionContextJson;
    value.error ||= parseErrorJson(value.errorJson);
    const deserialized = deserializeRunError(compact(value));
    const parsed = WorkflowRunSchema.parse(deserialized);
    const resolveData = params?.resolveData ?? 'all';
    return filterRunData(parsed, resolveData);
  }) as Storage['runs']['get'];

  return {
    get: getRun,

    /**
     * Long poll for a terminal run status. See
     * `Storage['runs'].waitForTerminalStatus`.
     *
     * Reads the run, and while it is non-terminal parks on the run-terminal
     * `NOTIFY` (bounded by the backstop re-read interval) before reading
     * again. Returns the latest snapshot once `timeoutMs` is up, whatever its
     * status, and propagates `WorkflowRunNotFoundError` exactly as `get` does.
     */
    waitForTerminalStatus: (async (id, params) => {
      const deadline = Date.now() + (params?.timeoutMs ?? 0);
      while (true) {
        const run = await getRun(id, params);
        if (isTerminalWorkflowRunStatus(run.status)) return run;

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0 || params?.signal?.aborted) return run;

        const waitMs = Math.min(remainingMs, getRunStatusPollIntervalMs());
        if (runStatusListener) {
          await runStatusListener.wait(id, waitMs, params?.signal);
        } else {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }) as NonNullable<Storage['runs']['waitForTerminalStatus']>,
    getMany: (async (ids, params) => {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) {
        return [];
      }

      const values = await drizzle
        .select()
        .from(runs)
        .where(inArray(runs.runId, uniqueIds));
      const resolveData = params?.resolveData ?? 'all';
      const runsById = new Map(
        values.map((value) => {
          value.output ||= value.outputJson;
          value.input ||= value.inputJson;
          value.executionContext ||= value.executionContextJson;
          value.error ||= parseErrorJson(value.errorJson);
          const parsed = WorkflowRunSchema.parse(
            deserializeRunError(compact(value))
          );
          return [value.runId, filterRunData(parsed, resolveData)] as const;
        })
      );

      return ids.map((id) => runsById.get(id) ?? null);
    }) as NonNullable<Storage['runs']['getMany']>,
    list: (async (params) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(runs)
        .where(
          and(
            map(fromCursor, (c) => lt(runs.runId, c)),
            map(params?.workflowName, (wf) => eq(runs.workflowName, wf)),
            map(params?.status, (wf) => eq(runs.status, wf))
          )
        )
        .orderBy(desc(runs.runId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.output ||= v.outputJson;
          v.input ||= v.inputJson;
          v.executionContext ||= v.executionContextJson;
          v.error ||= parseErrorJson(v.errorJson);
          const deserialized = deserializeRunError(compact(v));
          const parsed = WorkflowRunSchema.parse(deserialized);
          return filterRunData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    }) as Storage['runs']['list'],

    experimentalSetAttributes: async (
      runId: string,
      changes: AttributeChange[],
      options?: { allowReservedAttributes?: boolean }
    ): Promise<ExperimentalSetAttributesResult> => {
      // Load existing attributes so the SDK-shape validator can produce
      // a precise error message (cap, duplicate keys, reserved prefix,
      // byte length). The authoritative cap enforcement happens inside
      // the UPDATE statement below (see the `WHERE` clause), so the
      // race between this read and the UPDATE cannot push the row past
      // the per-run cap.
      const [existing] = await drizzle
        .select({ attributes: runs.attributes })
        .from(runs)
        .where(eq(runs.runId, runId))
        .limit(1);
      if (!existing) {
        throw new WorkflowRunNotFoundError(runId);
      }

      try {
        validateAttributeChanges(changes, {
          existingKeys: Object.keys(existing.attributes ?? {}),
          allowReservedAttributes: options?.allowReservedAttributes,
        });
      } catch (err) {
        if (err instanceof AttributeValidationError) throw err;
        throw err;
      }

      // Build a single SQL expression that applies all changes
      // atomically. Sets fold into nested `jsonb_set` calls; removes
      // fold into chained `-` (delete) operators.
      let expr = sql`COALESCE(${runs.attributes}, '{}'::jsonb)`;
      for (const { key, value } of changes) {
        if (value === null) {
          expr = sql`${expr} - ${key}`;
        } else {
          expr = sql`jsonb_set(${expr}, ARRAY[${key}]::text[], to_jsonb(${value}::text), true)`;
        }
      }

      // Atomic cap enforcement: only commit the UPDATE if the
      // post-merge key count fits the per-run cap. Computed against
      // the *current* row state, so two concurrent writers adding
      // disjoint keys at the cap boundary cannot both succeed.
      // Drizzle re-renders `expr` twice in the SQL (`SET attributes =
      // ...` + the count check); `jsonb_set` is cheap so the
      // duplication is harmless.
      const [updated] = await drizzle
        .update(runs)
        .set({
          attributes: expr as any,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runs.runId, runId),
            sql`(SELECT COUNT(*) FROM jsonb_object_keys(${expr})) <= ${ATTRIBUTE_MAX_PER_RUN}`
          )
        )
        .returning({ attributes: runs.attributes });

      if (!updated) {
        // Either the run vanished mid-call, or the cap-check WHERE
        // clause rejected the UPDATE. Re-read to disambiguate.
        const [stillThere] = await drizzle
          .select({ attributes: runs.attributes })
          .from(runs)
          .where(eq(runs.runId, runId))
          .limit(1);
        if (!stillThere) {
          throw new WorkflowRunNotFoundError(runId);
        }
        throw new AttributeValidationError(
          `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN} after concurrent write`
        );
      }

      return { attributes: updated.attributes ?? {} };
    },
  };
}

function map<T, R>(obj: T | null | undefined, fn: (v: T) => R): undefined | R {
  return obj ? fn(obj) : undefined;
}

/**
 * Handle events for legacy runs (pre-event-sourcing, specVersion < 2).
 * Legacy runs use different behavior:
 * - run_cancelled: Skip event storage, directly update run
 * - wait_completed: Store event only (no entity mutation)
 * - hook_received: Store event only (hooks exist via old system, no entity mutation)
 * - Other events: Throw error (not supported for legacy runs)
 */
async function handleLegacyEventPostgres(
  drizzle: Drizzle,
  runId: string,
  eventId: string,
  data: any,
  currentRun: { status: string; specVersion: number | null },
  params?: { resolveData?: ResolveData }
): Promise<EventResult> {
  const resolveData = params?.resolveData ?? 'all';

  switch (data.eventType) {
    case 'run_cancelled': {
      // Legacy: Skip event storage, directly update run to cancelled
      const now = new Date();

      // Update run status to cancelled
      await drizzle
        .update(Schema.runs)
        .set({
          status: 'cancelled',
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(Schema.runs.runId, runId));

      // Delete all hooks and waits for this run
      await Promise.all([
        drizzle.delete(Schema.hooks).where(eq(Schema.hooks.runId, runId)),
        drizzle.delete(Schema.waits).where(eq(Schema.waits.runId, runId)),
      ]);

      // Fetch updated run for return value
      const [updatedRun] = await drizzle
        .select()
        .from(Schema.runs)
        .where(eq(Schema.runs.runId, runId))
        .limit(1);

      // Wake `runs.waitForTerminalStatus` waiters. This shortcut returns
      // before the notify in `createEventsStorage`, so without this a legacy
      // run's cancellation is only noticed by the backstop re-read.
      await notifyRunTerminal(drizzle, runId);

      // Return without event (legacy behavior skips event storage)
      // Type assertion: EventResult expects WorkflowRun, filterRunData may return WorkflowRunWithoutData
      return {
        run: updatedRun
          ? (filterRunData(
              deserializeRunError(compact(updatedRun)),
              resolveData
            ) as WorkflowRun)
          : undefined,
      };
    }

    case 'wait_completed':
    case 'hook_received': {
      // Legacy: Store event only (no entity mutation)
      // - wait_completed: for replay purposes
      // - hook_received: hooks exist via the old system; record the event
      //
      // hook_received additionally guards against a concurrent (or already
      // committed) terminal transition, mirroring the current-spec
      // hook_received transaction below: `FOR UPDATE` takes the run row
      // lock, blocking until any in-flight terminal UPDATE (including the
      // legacy run_cancelled path above) commits, then observes the
      // post-commit status.
      const insertLegacyEvent = (tx: Pick<Drizzle, 'insert'>) =>
        tx
          .insert(Schema.events)
          .values({
            runId,
            eventId,
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: 'eventData' in data ? data.eventData : undefined,
            specVersion: SPEC_VERSION_CURRENT,
          })
          .returning({ createdAt: Schema.events.createdAt });

      const [insertedEvent] =
        data.eventType === 'hook_received'
          ? await drizzle.transaction(async (tx) => {
              const [runRow] = await tx
                .select({ status: Schema.runs.status })
                .from(Schema.runs)
                .where(eq(Schema.runs.runId, runId))
                .for('update')
                .limit(1);
              if (!runRow) {
                throw new WorkflowRunNotFoundError(runId);
              }
              if (isTerminalWorkflowRunStatus(runRow.status)) {
                throw new RunExpiredError(
                  `Workflow run "${runId}" is already in terminal state "${runRow.status}"`
                );
              }
              return insertLegacyEvent(tx);
            }, SLOT_INSERT_TRANSACTION)
          : await insertLegacyEvent(drizzle);

      const event = EventSchema.parse({
        ...data,
        ...insertedEvent,
        runId,
        eventId,
      });
      return { event: stripEventDataRefs(event, resolveData) };
    }

    default:
      throw new Error(
        `Event type '${data.eventType}' not supported for legacy runs ` +
          `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
          `Please upgrade @workflow packages.`
      );
  }
}

export function createEventsStorage(drizzle: Drizzle): Storage['events'] {
  const hookRetentionLimitMs = getHookRetentionLimitMs();
  const ulid = monotonicFactory();
  const { events } = Schema;
  const ownerRunIsTerminal = drizzle
    .select({ runId: Schema.runs.runId })
    .from(Schema.runs)
    .where(
      and(
        eq(Schema.runs.runId, Schema.hooks.runId),
        inArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES)
      )
    );
  const hookRetentionEnded = or(
    isNull(Schema.hooks.tokenRetentionUntil),
    lte(Schema.hooks.tokenRetentionUntil, sql`now()`)
  );

  // Prepared statements for validation queries (performance optimization)
  const getRunForValidation = drizzle
    .select({
      status: Schema.runs.status,
      specVersion: Schema.runs.specVersion,
    })
    .from(Schema.runs)
    .where(eq(Schema.runs.runId, sql.placeholder('runId')))
    .limit(1)
    .prepare('events_get_run_for_validation');

  const getStepForValidation = drizzle
    .select({
      status: Schema.steps.status,
      startedAt: Schema.steps.startedAt,
      retryAfter: Schema.steps.retryAfter,
    })
    .from(Schema.steps)
    .where(
      and(
        eq(Schema.steps.runId, sql.placeholder('runId')),
        eq(Schema.steps.stepId, sql.placeholder('stepId'))
      )
    )
    .limit(1)
    .prepare('events_get_step_for_validation');

  const getHookByToken = drizzle
    .select({ hookId: Schema.hooks.hookId, runId: Schema.hooks.runId })
    .from(Schema.hooks)
    .where(
      and(
        eq(Schema.hooks.token, sql.placeholder('token')),
        or(
          gt(Schema.hooks.tokenRetentionUntil, sql`now()`),
          notExists(ownerRunIsTerminal)
        )
      )
    )
    .limit(1)
    .prepare('events_get_hook_by_token');

  // Used to distinguish a real same-hook duplicate from an orphaned
  // hook row left behind by a process / database interruption between
  // the hook INSERT and the events INSERT below (see the recovery
  // logic in the hook_created branch).
  const getHookCreatedEvent = drizzle
    .select({ eventId: events.eventId })
    .from(events)
    .where(
      and(
        eq(events.runId, sql.placeholder('runId')),
        eq(events.correlationId, sql.placeholder('correlationId')),
        eq(events.eventType, sql.placeholder('eventType'))
      )
    )
    .limit(1)
    .prepare('events_get_hook_created_for_run_correlation');

  const getWaitForValidation = drizzle
    .select({
      status: Schema.waits.status,
    })
    .from(Schema.waits)
    .where(eq(Schema.waits.waitId, sql.placeholder('waitId')))
    .limit(1)
    .prepare('events_get_wait_for_validation');

  return {
    async create(
      runId: string | null,
      data: AnyEventRequest,
      params?: CreateEventParams
    ): Promise<EventResult> {
      if (
        data.eventType === 'hook_created' &&
        data.eventData.tokenRetentionUntil !== undefined &&
        data.eventData.tokenRetentionUntil.getTime() >
          Date.now() + hookRetentionLimitMs
      ) {
        throw new WorkflowWorldError(
          `Hook minimum retention cannot exceed ${hookRetentionLimitMs / DAY_MS} days in the Postgres World.`,
          { status: 400 }
        );
      }

      // The id this call's event took, known only once its insert has
      // committed: on a slot-numbered run the position is chosen inside the
      // INSERT, so there is nothing to read before it.
      let eventId: string | undefined;
      let value: { createdAt: Date } | undefined;
      // Lazy, because on a legacy run this mints a ULID and on a slot run it
      // reads which of the two schemes applies. Every caller below awaits it
      // immediately before its insert. A caller that has already fixed the id
      // (run_created, which always takes the first slot) gets that back.
      const getEventId = async (
        db: DrizzleLike = drizzle
      ): Promise<string | SQL<string>> =>
        eventId ?? (await allocateEventId(db, effectiveRunId));

      // For run_created events, use client-provided runId or generate one server-side
      let effectiveRunId: string;
      if (data.eventType === 'run_created' && (!runId || runId === '')) {
        effectiveRunId = `wrun_${ulid()}`;
      } else if (!runId) {
        throw new Error('runId is required for non-run_created events');
      } else {
        effectiveRunId = runId;
      }

      // Validate client-provided runId timestamp is within acceptable threshold
      if (data.eventType === 'run_created' && runId && runId !== '') {
        const validationError = validateUlidTimestamp(effectiveRunId, 'wrun_');
        if (validationError) {
          throw new WorkflowWorldError(validationError);
        }
      }

      // specVersion is always sent by the runtime, but we provide a fallback for safety
      const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

      // Track entity created/updated for EventResult
      let run: WorkflowRun | undefined;
      let step: Step | undefined;
      let hook: Hook | undefined;
      let wait: Wait | undefined;
      // Lazy step start: set true when this step_started atomically created
      // the step (the caller won the create-claim). Surfaced on EventResult
      // as the runtime's exactly-once ownership signal.
      let stepCreatedLazily = false;
      const now = new Date();

      // Terminal step statuses for use in SQL WHERE clauses (atomic guard).
      // Must match the Vercel world's conditional expressions:
      //   ne(status, 'completed') AND ne(status, 'failed') AND ne(status, 'cancelled')
      const terminalStepStatuses: (typeof Schema.steps.status.enumValues)[number][] =
        [...TERMINAL_STEP_STATUSES];

      // ============================================================
      // VALIDATION: Terminal state and event ordering checks
      // ============================================================

      // Get current run state for validation (if not creating a new run)
      // Skip run validation for step_completed and step_retrying - they only operate
      // on running steps, and running steps are always allowed to modify regardless
      // of run state. This optimization saves database queries per step event.
      let currentRun: { status: string; specVersion: number | null } | null =
        null;
      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (
        data.eventType !== 'run_created' &&
        !skipRunValidationEvents.includes(data.eventType)
      ) {
        // Use prepared statement for better performance
        const [runValue] = await getRunForValidation.execute({
          runId: effectiveRunId,
        });
        currentRun = runValue ?? null;

        // Resilient start: run_started on non-existent run with eventData
        // creates the run first, so the queue can bootstrap a run that
        // failed to create during start().
        if (
          data.eventType === 'run_started' &&
          !currentRun &&
          'eventData' in data &&
          data.eventData
        ) {
          const runInputData = (data as any).eventData as {
            deploymentId?: string;
            workflowName?: string;
            input?: any;
            executionContext?: Record<string, any>;
            attributes?: Record<string, string>;
            allowReservedAttributes?: true;
            encryptionPublicKey?: string;
          };
          const { deploymentId, input, workflowName } = runInputData;
          if (deploymentId && workflowName && input !== undefined) {
            validateAttributeChanges(
              Object.entries(runInputData.attributes ?? {}).map(
                ([key, value]) => ({ key, value })
              ),
              {
                allowReservedAttributes:
                  runInputData.allowReservedAttributes === true,
              }
            );
            // Create run + run_created event atomically. The
            // transaction ensures we never have an orphaned run
            // without its run_created event.
            const createdRun = await drizzle.transaction(async (tx) => {
              const [inserted] = await tx
                .insert(Schema.runs)
                .values({
                  runId: effectiveRunId,
                  deploymentId,
                  workflowName,
                  specVersion: effectiveSpecVersion,
                  input: input as SerializedContent,
                  executionContext: runInputData.executionContext as
                    | SerializedContent
                    | undefined,
                  attributes: runInputData.attributes,
                  // Must be mirrored here too: this is the path that recreates a
                  // run from the queued message, which is exactly when the key
                  // would otherwise be lost for the rest of the run's life.
                  encryptionPublicKey: runInputData.encryptionPublicKey,
                  status: 'pending',
                })
                .onConflictDoNothing()
                .returning();
              if (!inserted) return;

              // This synthetic run_created is the run's first event, so it
              // opens the slot counter the rest of the run allocates from.
              const runCreatedEventId = await openEventSlots(
                tx,
                effectiveRunId
              );
              await tx.insert(events).values({
                runId: effectiveRunId,
                eventId: runCreatedEventId,
                eventType: 'run_created',
                eventData: {
                  deploymentId,
                  workflowName,
                  input,
                  executionContext: runInputData.executionContext,
                  attributes: runInputData.attributes,
                  allowReservedAttributes: runInputData.allowReservedAttributes,
                  encryptionPublicKey: runInputData.encryptionPublicKey,
                },
                specVersion: effectiveSpecVersion,
              });
              return inserted;
            }, SLOT_INSERT_TRANSACTION);

            if (createdRun) {
              currentRun = {
                status: 'pending',
                specVersion: effectiveSpecVersion,
              };
            } else {
              // Run already exists (concurrent run_created won the
              // race). Re-read so downstream logic sees the real state.
              const [runValue] = await getRunForValidation.execute({
                runId: effectiveRunId,
              });
              currentRun = runValue ?? null;
            }
          }
        }
      }

      // ============================================================
      // VERSION COMPATIBILITY: Check run spec version
      // ============================================================
      // For events that have fetched the run, check version compatibility.
      // Skip for run_created (no existing run) and runtime events (step_completed, step_retrying).
      if (currentRun) {
        // Check if run requires a newer world version
        if (requiresNewerWorld(currentRun.specVersion)) {
          throw new RunNotSupportedError(
            currentRun.specVersion!,
            SPEC_VERSION_CURRENT
          );
        }

        // Route to legacy handler for pre-event-sourcing runs. A run this old
        // is ULID-numbered by definition, so the id is minted here rather than
        // read out of a slot marker the run cannot have.
        if (isLegacySpecVersion(currentRun.specVersion)) {
          return handleLegacyEventPostgres(
            drizzle,
            effectiveRunId,
            `wevt_${legacyEventUlid()}`,
            data,
            currentRun,
            params
          );
        }
      }
      if (
        !currentRun &&
        (data.eventType === 'attr_set' || data.eventType === 'run_started')
      ) {
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }

      // Lazy step start: a step_started carrying step-creation data
      // (stepName + input) may arrive with no prior step_created. It creates
      // the step on the fly (see the materialization block below). This
      // mirrors the resilient run_started path. Detect it here so the
      // entity-creation terminal-run guard treats it like a creation and the
      // "step must exist" ordering guard below doesn't reject it.
      const createsChildEntity = isChildEntityCreationEvent(data);
      const lazyStepStart =
        createsChildEntity && data.eventType === 'step_started';

      // Run terminal state validation
      if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
        // Idempotent operation: run_cancelled on already cancelled run is allowed
        if (
          data.eventType === 'run_cancelled' &&
          currentRun.status === 'cancelled'
        ) {
          // Get full run for return value
          const [fullRun] = await drizzle
            .select()
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1);

          // Create the event (still record it)
          const value = await insertEventRow(drizzle, {
            runId: effectiveRunId,
            eventId: await getEventId(),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: 'eventData' in data ? data.eventData : undefined,
            specVersion: effectiveSpecVersion,
          });

          if (!value) {
            throw new EntityConflictError(
              `run_cancelled for run "${effectiveRunId}" could not be created`
            );
          }
          const result = {
            ...data,
            ...value,
            runId: effectiveRunId,
          };
          const parsed = EventSchema.parse(result);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: stripEventDataRefs(parsed, resolveData),
            run: fullRun ? deserializeRunError(compact(fullRun)) : undefined,
          };
        }

        // For run_started on terminal runs, use RunExpiredError so the
        // runtime knows to exit without retrying.
        if (data.eventType === 'run_started') {
          throw new RunExpiredError(
            `Workflow run "${effectiveRunId}" is already in terminal state "${currentRun.status}"`
          );
        }

        // Other run state transitions are not allowed on terminal runs
        if (isTerminalRunEventType(data.eventType)) {
          throw new EntityConflictError(
            `Cannot transition run from terminal state "${currentRun.status}"`
          );
        }

        // Creating new entities on terminal runs is not allowed. A lazy
        // step_started creates a step, so it is rejected here too. A bare
        // (non-lazy) step_started falls through to the step-validation block
        // below, which uses RunExpiredError for terminal runs.
        if (createsChildEntity) {
          throw new EntityConflictError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`
          );
        }

        if (data.eventType === 'attr_set') {
          throw new EntityConflictError(
            `Cannot set attributes on run in terminal state "${currentRun.status}"`
          );
        }
      }

      // Step-related event validation (ordering and terminal state)
      // Fetch status + startedAt so we can reuse for step_started (avoid double read)
      // Skip validation for step_completed/step_failed - use conditional UPDATE instead
      let validatedStep: {
        status: string;
        startedAt: Date | null;
        retryAfter: Date | null;
      } | null = null;
      const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
      if (
        stepEventsNeedingValidation.includes(data.eventType) &&
        data.correlationId
      ) {
        // Use prepared statement for better performance
        const [existingStep] = await getStepForValidation.execute({
          runId: effectiveRunId,
          stepId: data.correlationId,
        });

        validatedStep = existingStep ?? null;

        // Event ordering: step must exist before these events, except on the
        // lazy-start path, where step_started creates the step itself.
        if (!validatedStep && !lazyStepStart) {
          throw new WorkflowWorldError(
            `Step "${data.correlationId}" not found`
          );
        }

        // Lazy start exactly-once gate: a lazy step_started always CREATES the
        // step (the owned-inline path only sends one for a step whose
        // step_created it deferred). If the step already exists, a concurrent
        // handler won the create. This caller is a loser and must not start or
        // run the step. Throw EntityConflictError so the runtime's executeStep
        // maps it to `skipped`. Critical: the start UPDATE below permits
        // re-starting a non-terminal step (retries rely on that), so without
        // this gate a loser would re-start a running step and run the body a
        // second time. (A concurrent create that lands after this read is also
        // caught by the onConflictDoNothing()+returning() claim below.)
        if (lazyStepStart && validatedStep) {
          throw new EntityConflictError(
            `Step "${data.correlationId}" already created`
          );
        }

        // Terminal-state checks only apply when the step already exists.
        // validatedStep is null only on the lazy-start path (no step yet),
        // where there is nothing terminal to guard against.
        if (validatedStep) {
          // Step terminal state validation
          if (isTerminalStepStatus(validatedStep.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${validatedStep.status}"`
            );
          }

          // On terminal runs: only allow completing/failing in-progress steps
          if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
            if (validatedStep.status !== 'running') {
              throw new RunExpiredError(
                `Cannot modify non-running step on run in terminal state "${currentRun.status}"`
              );
            }
          }
        }
      }

      // Hook-related event validation (existence).
      //
      // An unlocked read outside any transaction, so it settles only the case
      // where the hook was already gone when the request arrived. It is NOT
      // what orders a delivery against a disposal: the disposal can commit in
      // the gap between this read and the append. Both writers take the hook's
      // row lock for that. See the `hook_disposed` and `hook_received`
      // branches below.
      if (isHookEventRequiringExistence(data.eventType) && data.correlationId) {
        const [existingHook] = await drizzle
          .select({ hookId: Schema.hooks.hookId })
          .from(Schema.hooks)
          .where(eq(Schema.hooks.hookId, data.correlationId))
          .limit(1);

        if (!existingHook) {
          throw new HookNotFoundError(data.correlationId);
        }
      }

      // ============================================================
      // Entity creation/updates based on event type
      // ============================================================

      // Handle run_created event: create the run entity atomically
      if (data.eventType === 'run_created') {
        const eventData = (data as any).eventData as {
          deploymentId: string;
          workflowName: string;
          input: any[];
          executionContext?: Record<string, any>;
          attributes?: Record<string, string>;
          allowReservedAttributes?: true;
          encryptionPublicKey?: string;
        };
        validateAttributeChanges(
          Object.entries(eventData.attributes ?? {}).map(([key, value]) => ({
            key,
            value,
          })),
          {
            allowReservedAttributes: eventData.allowReservedAttributes === true,
          }
        );
        const created = await drizzle.transaction(async (tx) => {
          const [runValue] = await tx
            .insert(Schema.runs)
            .values({
              runId: effectiveRunId,
              deploymentId: eventData.deploymentId,
              workflowName: eventData.workflowName,
              // Propagate specVersion from the event to the run entity
              specVersion: effectiveSpecVersion,
              input: eventData.input as SerializedContent,
              executionContext: eventData.executionContext as
                | SerializedContent
                | undefined,
              attributes: eventData.attributes,
              encryptionPublicKey: eventData.encryptionPublicKey,
              status: 'pending',
            })
            .onConflictDoNothing()
            .returning();
          if (!runValue) return;

          const runCreatedEventId = await openEventSlots(tx, effectiveRunId);
          const [eventValue] = await tx
            .insert(events)
            .values({
              runId: effectiveRunId,
              eventId: runCreatedEventId,
              eventType: data.eventType,
              eventData,
              specVersion: effectiveSpecVersion,
            })
            .returning({ createdAt: events.createdAt });
          return { eventId: runCreatedEventId, eventValue, runValue };
        }, SLOT_INSERT_TRANSACTION);
        // No row back means the run already exists: the resilient start path
        // (run_started on a non-existent run) won a TOCTOU race and created
        // it. Surface the conflict rather than returning `{ run: undefined }`.
        // start() already treats EntityConflictError as benign, and falling
        // through would append a duplicate run_created event to the log.
        if (!created) {
          throw new EntityConflictError(
            `Workflow run "${effectiveRunId}" already exists`
          );
        }
        eventId = created.eventId;
        value = { createdAt: created.eventValue.createdAt };
        run = deserializeRunError(compact(created.runValue));
      }

      // Handle run_started event: update run status
      if (data.eventType === 'run_started') {
        // If the run is already running, return it without inserting a
        // duplicate run_started event.  This makes run_started idempotent
        // for concurrent invocations: replay is deterministic, so letting
        // multiple callers proceed with the same run is safe.  We skip
        // preloaded events here because this is a rare race-condition path.
        // The runtime falls back to loadWorkflowRunEvents().
        if (currentRun?.status === 'running') {
          const [fullRun] = await drizzle
            .select()
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1);
          if (fullRun) {
            return { run: deserializeRunError(compact(fullRun)) };
          }
        }

        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'running',
            startedAt: now,
            updatedAt: now,
          })
          .where(eq(Schema.runs.runId, effectiveRunId))
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        }
      }

      // Handle run_completed event: update run status
      // Uses conditional UPDATE to prevent completing an already-terminal run.
      if (data.eventType === 'run_completed') {
        const eventData = (data as any).eventData as { output?: any };
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'completed',
            output: eventData.output as SerializedContent | undefined,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES)
            )
          )
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({
            runId: effectiveRunId,
          });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isTerminalWorkflowRunStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`
            );
          }
        }
      }

      // Handle run_failed event: update run status
      // Uses conditional UPDATE to prevent failing an already-terminal run.
      if (data.eventType === 'run_failed') {
        const eventData = (data as any).eventData as {
          error: unknown;
          errorCode?: string;
        };
        // The error field is SerializedData (Uint8Array) produced by
        // dehydrateRunError. We store it verbatim in the error_cbor column;
        // consumers hydrate via hydrateRunError.
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'failed',
            error: eventData.error as SerializedData,
            errorCode: eventData.errorCode,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES)
            )
          )
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({
            runId: effectiveRunId,
          });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isTerminalWorkflowRunStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`
            );
          }
        }
      }

      // Handle run_cancelled event: update run status
      // Uses conditional UPDATE to prevent cancelling an already-terminal run.
      // Note: idempotent run_cancelled on already-cancelled runs is handled
      // earlier in the pre-validation block (creates event and returns early).
      if (data.eventType === 'run_cancelled') {
        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            status: 'cancelled',
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              notInArray(Schema.runs.status, TERMINAL_WORKFLOW_RUN_STATUSES)
            )
          )
          .returning();
        if (runValue) {
          run = deserializeRunError(compact(runValue));
        } else {
          const [existing] = await getRunForValidation.execute({
            runId: effectiveRunId,
          });
          if (!existing) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isTerminalWorkflowRunStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot transition run from terminal state "${existing.status}"`
            );
          }
        }
      }

      if (isTerminalRunEventType(data.eventType)) {
        // Retained Hooks remain visible after the run ends. Other Hooks and
        // all waits are removed immediately.
        await Promise.all([
          drizzle
            .delete(Schema.hooks)
            .where(
              and(eq(Schema.hooks.runId, effectiveRunId), hookRetentionEnded)
            ),
          drizzle
            .delete(Schema.waits)
            .where(eq(Schema.waits.runId, effectiveRunId)),
        ]);
      }

      if (data.eventType === 'attr_set') {
        const { changes, allowReservedAttributes } = data.eventData;
        // Dedup pre-check for correlated workflow writes: if the event is
        // already in the log (a redelivered/replayed duplicate), reject
        // BEFORE materializing onto the run. Without this, a duplicate,
        // including a pathological one carrying different changes for the
        // same correlationId, would mutate `run.attributes` and then fail
        // the event insert, leaving the snapshot out of sync with the
        // event log. The unique index on the insert below still guards the
        // truly-concurrent race; both writers of that race carry identical
        // changes (deterministic replay), so the double-applied update is
        // idempotent there.
        if (data.correlationId && data.eventData.writer.type === 'workflow') {
          const [duplicate] = await drizzle
            .select({ eventId: events.eventId })
            .from(events)
            .where(
              and(
                eq(events.runId, effectiveRunId),
                eq(events.correlationId, data.correlationId),
                eq(events.eventType, 'attr_set')
              )
            )
            .limit(1);
          if (duplicate) {
            throw new EntityConflictError(
              `attr_set for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`
            );
          }
        }
        const [existing] = await drizzle
          .select({ attributes: Schema.runs.attributes })
          .from(Schema.runs)
          .where(eq(Schema.runs.runId, effectiveRunId))
          .limit(1);
        if (!existing) {
          throw new WorkflowRunNotFoundError(effectiveRunId);
        }
        validateAttributeChanges(changes, {
          existingKeys: Object.keys(existing.attributes ?? {}),
          allowReservedAttributes: allowReservedAttributes === true,
        });

        let expr = sql`COALESCE(${Schema.runs.attributes}, '{}'::jsonb)`;
        for (const { key, value } of changes) {
          if (value === null) {
            expr = sql`${expr} - ${key}`;
          } else {
            expr = sql`jsonb_set(${expr}, ARRAY[${key}]::text[], to_jsonb(${value}::text), true)`;
          }
        }

        const [runValue] = await drizzle
          .update(Schema.runs)
          .set({
            attributes: expr as any,
            updatedAt: now,
          })
          .where(
            and(
              eq(Schema.runs.runId, effectiveRunId),
              sql`(SELECT COUNT(*) FROM jsonb_object_keys(${expr})) <= ${ATTRIBUTE_MAX_PER_RUN}`
            )
          )
          .returning();
        if (!runValue) {
          // The guarded update matches zero rows either because the cap
          // condition failed or because the run row disappeared between the
          // existence check above and this update. Distinguish the two so
          // the error is not misattributed.
          const [stillExists] = await drizzle
            .select({ runId: Schema.runs.runId })
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .limit(1);
          if (!stillExists) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          throw new AttributeValidationError(
            `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN}`
          );
        }
        run = deserializeRunError(compact(runValue));
      }

      // Strip eventData from run_started. It belongs on run_created only.
      // For step_started on the lazy-start path, strip only the step `input`
      // (it belongs on the synthetic step_created written below); `stepName`
      // is preserved for the client replay consumer's step-name divergence
      // check.
      let storedEventData: unknown;
      if (data.eventType === 'run_started') {
        storedEventData = undefined;
      } else if ('eventData' in data && data.eventData) {
        if (
          data.eventType === 'step_started' &&
          'input' in (data.eventData as Record<string, unknown>)
        ) {
          const { input: _strippedInput, ...rest } = data.eventData as {
            input?: unknown;
          } & Record<string, unknown>;
          storedEventData = rest;
        } else {
          storedEventData = data.eventData;
        }
      } else {
        storedEventData = undefined;
      }

      // Handle step_started event: increment attempt and set the step to
      // running, then write the matching event log entry in the same
      // transaction. The guarded UPDATE takes the step row lock; keeping the
      // event INSERT behind that lock prevents a late step_started from being
      // ordered after a concurrent terminal event that already won the row.
      if (data.eventType === 'step_started') {
        value = await drizzle.transaction(async (tx) => {
          // Lazy step start: no prior step_created exists, but this
          // step_started carries the step-creation data. The step INSERT is
          // the ownership claim: only the caller that inserts the row gets to
          // run the step body inline.
          if (lazyStepStart && !validatedStep) {
            const lazyData = data.eventData;
            const [inserted] = await tx
              .insert(Schema.steps)
              .values({
                runId: effectiveRunId,
                stepId: data.correlationId,
                stepName: lazyData.stepName,
                input: lazyData.input as SerializedContent,
                status: 'pending',
                attempt: 0,
                specVersion: effectiveSpecVersion,
              })
              .onConflictDoNothing()
              .returning({ stepId: Schema.steps.stepId });

            if (!inserted) {
              throw new EntityConflictError(
                `Step "${data.correlationId}" already created`
              );
            }

            // Replay still needs to observe step_created before
            // step_started. Because this synthetic event is in the same
            // transaction as the lazy step row and step_started event, we
            // cannot leave behind only one side of that materialization.
            try {
              await insertEventRow(tx, {
                runId: effectiveRunId,
                eventId: await allocateEventId(tx, effectiveRunId),
                correlationId: data.correlationId,
                eventType: 'step_created',
                eventData: {
                  stepName: lazyData.stepName,
                  input: lazyData.input,
                },
                specVersion: effectiveSpecVersion,
              });
            } catch (err) {
              // A concurrent writer already published this run's
              // step_created for the same step. The event exists either way,
              // which is all this synthetic write was for.
              if (
                pgErrorOf(err).constraint !==
                'workflow_events_entity_creation_unique'
              ) {
                throw err;
              }
            }
            stepCreatedLazily = true;
          }

          // Retried steps may be scheduled for later. Keep this check inside
          // the transaction so the step_started write cannot slip past it.
          if (
            validatedStep?.retryAfter &&
            validatedStep.retryAfter.getTime() > Date.now()
          ) {
            throw new TooEarlyError(
              `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
              {
                retryAfter: Math.ceil(
                  (validatedStep.retryAfter.getTime() - Date.now()) / 1000
                ),
              }
            );
          }

          // The UPDATE includes the terminal-state guard in addition to the
          // earlier validation read. That closes the race where another
          // writer completes/fails the step between validation and start.
          const [stepValue] = await tx
            .update(Schema.steps)
            .set({
              status: 'running',
              attempt: sql`${Schema.steps.attempt} + 1`,
              // Preserve the original first-start timestamp across retries or
              // overlapping starts.
              startedAt: sql`COALESCE(${Schema.steps.startedAt}, ${now.toISOString()})`,
              retryAfter: null,
            })
            .where(
              and(
                eq(Schema.steps.runId, effectiveRunId),
                eq(Schema.steps.stepId, data.correlationId!),
                notInArray(Schema.steps.status, terminalStepStatuses)
              )
            )
            .returning();

          if (stepValue) {
            step = deserializeStepError(compact(stepValue));
          } else {
            const [existing] = await tx
              .select({ status: Schema.steps.status })
              .from(Schema.steps)
              .where(
                and(
                  eq(Schema.steps.runId, effectiveRunId),
                  eq(Schema.steps.stepId, data.correlationId!)
                )
              )
              .limit(1);
            if (!existing) {
              throw new WorkflowWorldError(
                `Step "${data.correlationId}" not found`
              );
            }
            if (isTerminalStepStatus(existing.status)) {
              throw new EntityConflictError(
                `Cannot modify step in terminal state "${existing.status}"`
              );
            }
          }

          // Allocate the step_started position only after the guarded step
          // UPDATE has acquired and passed the row lock, so a writer blocked
          // on the step row cannot carry an earlier position into a later
          // insert.
          const eventValue = await insertEventRow(tx, {
            runId: effectiveRunId,
            eventId: await allocateEventId(tx, effectiveRunId),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: storedEventData,
            specVersion: effectiveSpecVersion,
          });

          if (!eventValue) {
            throw new EntityConflictError(
              `Event for step "${data.correlationId}" could not be created`
            );
          }
          eventId = eventValue.eventId;
          return { createdAt: eventValue.createdAt };
        }, SLOT_INSERT_TRANSACTION);
      }

      // Handle step_completed event: update step status
      // Uses conditional UPDATE to prevent completing an already-terminal step.
      if (data.eventType === 'step_completed') {
        const eventData = (data as any).eventData as { result?: any };
        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'completed',
            output: eventData.result as SerializedContent | undefined,
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
              notInArray(Schema.steps.status, terminalStepStatuses)
            )
          )
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact(stepValue));
        } else {
          // Step not updated - check if it exists and why
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId!,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`
            );
          }
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`
            );
          }
        }
      }

      // Handle step_failed event: terminal state with error
      // Uses conditional UPDATE to prevent failing an already-terminal step.
      if (data.eventType === 'step_failed') {
        const eventData = (data as any).eventData as {
          error?: unknown;
        };
        // The error field is SerializedData (Uint8Array) produced by
        // dehydrateStepError. We store it verbatim in the error_cbor column;
        // consumers hydrate via hydrateStepError.
        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'failed',
            error: eventData.error as SerializedData,
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
              notInArray(Schema.steps.status, terminalStepStatuses)
            )
          )
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact(stepValue));
        } else {
          // Step not updated - check if it exists and why
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId!,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`
            );
          }
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`
            );
          }
        }
      }

      // Handle step_retrying event: sets status back to 'pending', records error
      // Uses conditional UPDATE to prevent retrying an already-terminal step.
      if (data.eventType === 'step_retrying') {
        const eventData = (data as any).eventData as {
          error?: unknown;
          retryAfter?: Date;
        };
        const [stepValue] = await drizzle
          .update(Schema.steps)
          .set({
            status: 'pending',
            error: eventData.error as SerializedData,
            retryAfter: eventData.retryAfter,
          })
          .where(
            and(
              eq(Schema.steps.runId, effectiveRunId),
              eq(Schema.steps.stepId, data.correlationId!),
              notInArray(Schema.steps.status, terminalStepStatuses)
            )
          )
          .returning();
        if (stepValue) {
          step = deserializeStepError(compact(stepValue));
        } else {
          // Step not updated - check if it exists and why
          const [existing] = await getStepForValidation.execute({
            runId: effectiveRunId,
            stepId: data.correlationId!,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Step "${data.correlationId}" not found`
            );
          }
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`
            );
          }
        }
      }

      // Handle hook_created event: create hook entity
      // Uses prepared statement for token uniqueness check (performance optimization)
      if (data.eventType === 'hook_created') {
        const { eventData } = data;

        // Check for duplicate token using prepared statement
        const [existingHook] = await getHookByToken.execute({
          token: eventData.token,
        });
        if (existingHook) {
          // Idempotency: if the existing hook is the *same* (runId, hookId)
          // we are trying to create, this is either a duplicate / replayed
          // processing of the same hook_created (not a real conflict), or
          // an orphaned hook row from a prior crashed attempt (the hook
          // INSERT below landed but the events INSERT below didn't;
          // these writes are not in one transaction). Distinguish by
          // checking whether the `hook_created` event actually exists in
          // the event log:
          //   - exists → real duplicate: throw EntityConflictError so the
          //     runtime's concurrent-replay catch path (matching the
          //     step_created path) swallows it, instead of producing a
          //     self-conflict in the event log that would later replay
          //     as HookConflictError.
          //     See https://github.com/vercel/workflow/issues/2283.
          //   - missing → orphaned hook row (crash between hook INSERT
          //     and events INSERT): skip the hook insert (the existing
          //     row already has the desired state) and fall through to
          //     the events INSERT below, completing the partial write.
          if (
            existingHook.runId === effectiveRunId &&
            existingHook.hookId === data.correlationId
          ) {
            const [existingEvent] = await getHookCreatedEvent.execute({
              runId: effectiveRunId,
              correlationId: data.correlationId,
              eventType: 'hook_created',
            });
            if (existingEvent) {
              throw new EntityConflictError(
                `Hook "${data.correlationId}" already created`
              );
            }
            // Orphaned hook row: hook row exists but no hook_created
            // event in the log. Skip the hook insert below (the row
            // already exists with our (runId, hookId)) and let the
            // outer code path emit the hook_created event, completing
            // the partial write. We also re-fetch the existing hook
            // row so the EventResult carries the actual persisted
            // entity rather than `undefined`.
            const [recoveredHookValue] = await drizzle
              .select()
              .from(Schema.hooks)
              .where(eq(Schema.hooks.hookId, data.correlationId!))
              .limit(1);
            if (recoveredHookValue) {
              recoveredHookValue.metadata ||= recoveredHookValue.metadataJson;
              hook = HookSchema.parse(compact(recoveredHookValue));
            }
          } else {
            // Cross-hook / cross-run conflict: a different
            // (runId, hookId) holds this token. Create a hook_conflict
            // event instead of throwing 409. This lets the workflow
            // continue and fail gracefully when the hook is awaited.
            const conflictEventData = {
              token: eventData.token,
              conflictingRunId: existingHook.runId,
            };
            const conflictValue = await insertEventRow(drizzle, {
              runId: effectiveRunId,
              eventId: await getEventId(),
              correlationId: data.correlationId,
              eventType: 'hook_conflict',
              eventData: conflictEventData,
              specVersion: effectiveSpecVersion,
            });

            if (!conflictValue) {
              throw new EntityConflictError(
                `hook_conflict for run "${effectiveRunId}" could not be created`
              );
            }
            const conflictEventId = conflictValue.eventId;
            eventId = conflictEventId;

            const conflictResult = {
              eventType: 'hook_conflict' as const,
              correlationId: data.correlationId,
              eventData: conflictEventData,
              ...conflictValue,
              runId: effectiveRunId,
              eventId: conflictEventId,
            };
            const parsedConflict = EventSchema.parse(conflictResult);
            const resolveData = params?.resolveData ?? 'all';
            return {
              event: stripEventDataRefs(parsedConflict, resolveData),
              run,
              step,
              hook: undefined,
            };
          }
        } else {
          await drizzle
            .delete(Schema.hooks)
            .where(
              and(
                eq(Schema.hooks.token, eventData.token),
                exists(ownerRunIsTerminal),
                hookRetentionEnded
              )
            );

          const [hookValue] = await drizzle
            .insert(Schema.hooks)
            .values({
              runId: effectiveRunId,
              hookId: data.correlationId!,
              token: eventData.token,
              metadata: eventData.metadata as SerializedContent,
              ownerId: '', // TODO: get from context
              projectId: '', // TODO: get from context
              environment: '', // TODO: get from context
              tokenRetentionUntil: eventData.tokenRetentionUntil,
              // Propagate specVersion from the event to the hook entity
              specVersion: effectiveSpecVersion,
              isWebhook: eventData.isWebhook,
              isSystem: eventData.isSystem ?? false,
            })
            .onConflictDoNothing()
            .returning();
          if (hookValue) {
            hookValue.metadata ||= hookValue.metadataJson;
            hook = HookSchema.parse(compact(hookValue));
          }
        }
      }

      // Handle hook_disposed event: delete the hook entity and append the
      // disposal in ONE transaction.
      //
      // `DELETE ... RETURNING` ensures only one concurrent caller succeeds. If
      // no rows are returned, the hook was already disposed. The delete also
      // takes the hook row's lock, and the transaction is what holds it until
      // the `hook_disposed` row exists. Committed separately (as this used to
      // be), the lock is released at the delete's own autocommit, which leaves a
      // window for a resume to pass its existence check and land its
      // `hook_received` AFTER this disposal. That order is durable, and it
      // corrupts the owning run for good: no replay can consume a delivery
      // behind the disposal that retired the hook's consumer, so it strands,
      // every replay reports divergence and the run ends in
      // CorruptedEventLogError. See vercel/workflow#2781, which fixed the same
      // ordering for world-local.
      if (data.eventType === 'hook_disposed' && data.correlationId) {
        const disposedHookId = data.correlationId;
        value = await drizzle.transaction(async (tx) => {
          const [deleted] = await tx
            .delete(Schema.hooks)
            .where(eq(Schema.hooks.hookId, disposedHookId))
            .returning({ hookId: Schema.hooks.hookId });
          if (!deleted) {
            throw new EntityConflictError(
              `Hook "${disposedHookId}" already disposed`
            );
          }

          // Allocated only after the lock is held, matching hook_received's
          // ordering guarantee: a writer that had to wait must not carry an
          // earlier position into a later insert.
          const eventValue = await insertEventRow(tx, {
            runId: effectiveRunId,
            eventId: await getEventId(tx),
            correlationId: disposedHookId,
            eventType: data.eventType,
            eventData: storedEventData,
            specVersion: effectiveSpecVersion,
          });
          if (!eventValue) {
            throw new EntityConflictError(
              `Event for hook "${disposedHookId}" could not be created`
            );
          }
          eventId = eventValue.eventId;
          return { createdAt: eventValue.createdAt };
        }, SLOT_INSERT_TRANSACTION);
      }

      // Handle hook_received event: append the event only if the run has
      // not reached a terminal state. hook_received has no branch in the
      // terminal-run guard above (it doesn't transition the run or create
      // an entity), so without this, the generic INSERT further below
      // could append a hook_received event after a concurrent
      // run_completed / run_failed / run_cancelled has already committed.
      // `FOR UPDATE` takes the run row lock inside this transaction: it
      // blocks until any in-flight terminal transition (whose own
      // conditional UPDATE takes the same row lock) commits, then
      // observes the post-commit status. That linearizes this insert
      // against the run's terminal transition the same way step_started's
      // guarded UPDATE linearizes against a concurrent terminal step
      // event.
      if (data.eventType === 'hook_received') {
        value = await drizzle.transaction(async (tx) => {
          const [runRow] = await tx
            .select({ status: Schema.runs.status })
            .from(Schema.runs)
            .where(eq(Schema.runs.runId, effectiveRunId))
            .for('update')
            .limit(1);
          if (!runRow) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          if (isTerminalWorkflowRunStatus(runRow.status)) {
            throw new RunExpiredError(
              `Workflow run "${effectiveRunId}" is already in terminal state "${runRow.status}"`
            );
          }

          // Re-check the hook under its own row lock, for the ordering the
          // unlocked read near the top of `create` cannot settle. `FOR UPDATE`
          // blocks on the disposer's `DELETE`, which holds that lock until its
          // `hook_disposed` row is committed, then re-evaluates: either this
          // delivery got the lock first and its `hook_received` is ordered
          // BEFORE the disposal, or the disposer got it and the row is gone and
          // this delivery is refused. The one order that is unreachable is the
          // one that corrupts the run: a `hook_received` journaled behind its
          // hook's `hook_disposed`, which no replay can consume.
          //
          // Under READ COMMITTED (see SLOT_INSERT_TRANSACTION) a locked read of
          // a row deleted by the transaction it waited on returns no row rather
          // than raising, so the refusal needs no serialization-failure
          // handling. Reported as HookNotFoundError, matching the unlocked
          // check and the public resume contract for a hook that can no longer
          // receive.
          if (data.correlationId) {
            const [liveHook] = await tx
              .select({ hookId: Schema.hooks.hookId })
              .from(Schema.hooks)
              .where(eq(Schema.hooks.hookId, data.correlationId))
              .for('update')
              .limit(1);
            if (!liveHook) {
              throw new HookNotFoundError(data.correlationId);
            }
          }

          // Allocate the position only after the row locks are acquired,
          // matching step_started's ordering guarantee: a writer blocked
          // on a lock must not carry an earlier position into a later
          // insert.
          const eventValue = await insertEventRow(tx, {
            runId: effectiveRunId,
            eventId: await allocateEventId(tx, effectiveRunId),
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData: storedEventData,
            specVersion: effectiveSpecVersion,
          });

          if (!eventValue) {
            throw new EntityConflictError(
              `Event for hook "${data.correlationId}" could not be created`
            );
          }
          eventId = eventValue.eventId;
          return { createdAt: eventValue.createdAt };
        }, SLOT_INSERT_TRANSACTION);
      }

      // Handle wait_created event: create wait entity
      if (data.eventType === 'wait_created') {
        const eventData = (data as any).eventData as {
          resumeAt?: Date;
        };
        const waitId = `${effectiveRunId}-${data.correlationId}`;
        const [waitValue] = await drizzle
          .insert(Schema.waits)
          .values({
            waitId,
            runId: effectiveRunId,
            status: 'waiting',
            resumeAt: eventData.resumeAt,
            specVersion: effectiveSpecVersion,
          })
          .onConflictDoNothing()
          .returning();
        if (waitValue) {
          wait = {
            waitId: waitValue.waitId,
            runId: waitValue.runId,
            status: waitValue.status,
            resumeAt: waitValue.resumeAt ?? undefined,
            completedAt: waitValue.completedAt ?? undefined,
            createdAt: waitValue.createdAt,
            updatedAt: waitValue.updatedAt,
            specVersion: waitValue.specVersion ?? undefined,
          };
        } else {
          throw new EntityConflictError(
            `Wait "${data.correlationId}" already exists`
          );
        }
      }

      // Handle wait_completed event: transition wait to 'completed'
      // Uses conditional UPDATE to reject duplicate completions (same pattern as step_completed)
      if (data.eventType === 'wait_completed') {
        const waitId = `${effectiveRunId}-${data.correlationId}`;
        const [waitValue] = await drizzle
          .update(Schema.waits)
          .set({
            status: 'completed',
            completedAt: now,
          })
          .where(
            and(
              eq(Schema.waits.waitId, waitId),
              eq(Schema.waits.status, 'waiting')
            )
          )
          .returning();
        if (waitValue) {
          wait = {
            waitId: waitValue.waitId,
            runId: waitValue.runId,
            status: waitValue.status,
            resumeAt: waitValue.resumeAt ?? undefined,
            completedAt: waitValue.completedAt ?? undefined,
            createdAt: waitValue.createdAt,
            updatedAt: waitValue.updatedAt,
            specVersion: waitValue.specVersion ?? undefined,
          };
        } else {
          // Wait not updated - check if it exists and why
          const [existing] = await getWaitForValidation.execute({
            waitId,
          });
          if (!existing) {
            throw new WorkflowWorldError(
              `Wait "${data.correlationId}" not found`
            );
          }
          if (existing.status === 'completed') {
            throw new EntityConflictError(
              `Wait "${data.correlationId}" already completed`
            );
          }
        }
      }

      try {
        if (!value) {
          let inserted: Awaited<ReturnType<typeof insertEventRow>>;
          if (data.eventType === 'step_created') {
            const eventData = data.eventData;
            const created = await drizzle.transaction(async (tx) => {
              let [stepValue] = await tx
                .insert(Schema.steps)
                .values({
                  runId: effectiveRunId,
                  stepId: data.correlationId,
                  stepName: eventData.stepName,
                  input: eventData.input as SerializedContent,
                  status: 'pending',
                  attempt: 0,
                  specVersion: effectiveSpecVersion,
                })
                .onConflictDoNothing()
                .returning();
              if (!stepValue) {
                const [existingEvent] = await tx
                  .select({ eventId: Schema.events.eventId })
                  .from(Schema.events)
                  .where(
                    and(
                      eq(Schema.events.runId, effectiveRunId),
                      eq(Schema.events.correlationId, data.correlationId),
                      eq(Schema.events.eventType, 'step_created')
                    )
                  )
                  .limit(1);
                if (existingEvent) {
                  throw new EntityConflictError(
                    `step_created for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`
                  );
                }

                // A row without its matching event was left by the old
                // non-transactional path. Keep the row and complete the
                // missing event inside this transaction so existing orphans
                // remain recoverable while new partial writes cannot escape.
                [stepValue] = await tx
                  .select()
                  .from(Schema.steps)
                  .where(
                    and(
                      eq(Schema.steps.runId, effectiveRunId),
                      eq(Schema.steps.stepId, data.correlationId)
                    )
                  )
                  .limit(1);
                if (!stepValue) {
                  throw new EntityConflictError(
                    `step_created for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`
                  );
                }
              }

              const eventValue = await insertEventRow(tx, {
                runId: effectiveRunId,
                eventId: await getEventId(tx),
                correlationId: data.correlationId,
                eventType: data.eventType,
                eventData: storedEventData,
                specVersion: effectiveSpecVersion,
              });
              if (!eventValue) {
                throw new EntityConflictError(
                  `step_created for run "${effectiveRunId}" could not be created`
                );
              }
              return { eventValue, stepValue };
            }, SLOT_INSERT_TRANSACTION);

            step = deserializeStepError(compact(created.stepValue));
            inserted = created.eventValue;
          } else {
            inserted = await insertEventRow(drizzle, {
              runId: effectiveRunId,
              eventId: await getEventId(),
              correlationId: data.correlationId,
              eventType: data.eventType,
              eventData: storedEventData,
              specVersion: effectiveSpecVersion,
            });
          }
          if (inserted) {
            eventId = inserted.eventId;
            value = { createdAt: inserted.createdAt };
          }
        }
      } catch (err) {
        // Translate unique-violation on the correlated-event partial index
        // (workflow_events_entity_creation_unique) into EntityConflictError
        // so the runtime's existing dedup catch path can handle it. Without
        // this, two concurrent invocations producing identical
        // correlationIds (e.g. snapshot runtime deterministic ULIDs) would
        // surface as unhandled DB errors instead of dedup signals.
        // Drizzle wraps the underlying pg error in DrizzleQueryError; the
        // pg error (with .code === '23505') lives on .cause. We additionally
        // gate on the violated constraint name so other 23505 violations on
        // these event types (e.g. the events primary key, or any future
        // unique constraint we might add) don't get misclassified as a
        // correlationId conflict.
        const isDeduplicatedCorrelatedEvent =
          isChildEntityCreationEventType(data.eventType) ||
          (data.eventType === 'attr_set' &&
            data.eventData.writer.type === 'workflow');
        const pgErr = pgErrorOf(err);
        const pgCode = pgErr.code;
        const pgConstraint = pgErr.constraint;
        if (
          isDeduplicatedCorrelatedEvent &&
          pgCode === '23505' &&
          pgConstraint === 'workflow_events_entity_creation_unique'
        ) {
          throw new EntityConflictError(
            `${data.eventType} for correlationId "${data.correlationId}" already exists in run "${effectiveRunId}"`
          );
        }
        throw err;
      }
      if (!value || !eventId) {
        throw new EntityConflictError(
          `${data.eventType} for run "${effectiveRunId}" could not be created`
        );
      }
      const result = {
        ...data,
        ...value,
        runId: effectiveRunId,
        eventId,
        ...(storedEventData !== undefined
          ? { eventData: storedEventData }
          : {}),
      };
      // Strip eventData leaked by ...data spread for run_started events.
      // The eventData (run input for resilient start) belongs on
      // run_created only; storedEventData is already undefined above.
      if (data.eventType === 'run_started') {
        delete (result as any).eventData;
      }
      const parsed = EventSchema.parse(result);
      const resolveData = params?.resolveData ?? 'all';

      // For run_started: include all events so the runtime can skip
      // the initial events.list call and reduce TTFB.
      let eventPage: PaginatedResponse<Event> | undefined;
      // The skipped-slot report and the inline delta below share
      // `events`/`cursor`/`hasMore`, and the runtime sends both on the same
      // write. The delta wins: the skipped slots all sit above the cursor, so
      // it is a strict superset, and it is the only one of the two that
      // advances `cursor`. Running the report anyway would cost a query whose
      // result the delta overwrites.
      if (
        params?.eventCount !== undefined &&
        typeof params.sinceCursor !== 'string'
      ) {
        const report = await reportSkippedSlots(
          drizzle,
          effectiveRunId,
          parsed.eventId,
          params.eventCount,
          resolveData
        );
        if (report) {
          // Deliberately no cursor: the report is a lower bound on what this
          // write skipped over, not a page the caller has now read to the end
          // of, so it must not advance the caller's read position.
          eventPage = {
            data: report.events,
            cursor: null,
            hasMore: report.hasMore,
          };
        }
      }
      if (data.eventType === 'run_started' && run && !params?.skipPreload) {
        const eventRows = await drizzle
          .select()
          .from(Schema.events)
          .where(eq(Schema.events.runId, effectiveRunId))
          .orderBy(Schema.events.eventId);
        const data = eventRows.map((e) => {
          e.eventData ||= e.eventDataJson;
          const parsed = EventSchema.parse(compact(e));
          return stripEventDataRefs(parsed, resolveData);
        });
        eventPage = {
          data,
          cursor: data.at(-1)?.eventId ?? null,
          hasMore: false,
        };
      }

      // Inline delta: the caller told us the cursor of the log it holds, so
      // return the page `events.list({ cursor: sinceCursor, sortOrder: 'asc' })`
      // would return right now and save it the round-trip. Same query, same
      // page size, same cursor semantics as `list` below. Deliberately not
      // paginated to exhaustion, since the contract is
      // single-page-or-fall-back and the caller ignores a delta with
      // `hasMore: true`.
      if (typeof params?.sinceCursor === 'string') {
        const limit = 100;
        const deltaRows = await drizzle
          .select()
          .from(Schema.events)
          .where(
            and(
              eq(Schema.events.runId, effectiveRunId),
              gt(Schema.events.eventId, params.sinceCursor)
            )
          )
          .orderBy(Schema.events.eventId)
          .limit(limit + 1);
        const page = deltaRows.slice(0, limit);
        const data = page.map((e) => {
          e.eventData ||= e.eventDataJson;
          return stripEventDataRefs(EventSchema.parse(compact(e)), resolveData);
        });
        eventPage = {
          data,
          cursor: data.at(-1)?.eventId ?? null,
          hasMore: deltaRows.length > limit,
        };
      }

      // Wake `runs.waitForTerminalStatus` waiters. Every current-spec
      // run-terminal transition passes through here (run_completed /
      // run_failed / run_cancelled all update the row above), and the update
      // has committed by now, so a woken waiter re-reads a terminal run. The
      // early-return paths above are the idempotent ones: a run that was
      // *already* terminal, whose original transition announced itself. The
      // one terminal write that does NOT reach here is the legacy
      // (specVersion < 2) `run_cancelled` shortcut, which returns from
      // `handleLegacyEventPostgres` and notifies for itself.
      if (run && isTerminalWorkflowRunStatus(run.status)) {
        await notifyRunTerminal(drizzle, effectiveRunId);
      }

      const eventResult: EventResult = {
        event: stripEventDataRefs(parsed, resolveData),
        run,
        step,
        hook,
        wait,
        ...(stepCreatedLazily ? { stepCreated: true } : {}),
      };

      if (!eventPage) return eventResult;

      return {
        ...eventResult,
        events: eventPage.data,
        cursor: eventPage.cursor,
        hasMore: eventPage.hasMore,
      };
    },
    async get(
      runId: string,
      eventId: string,
      params?: GetEventParams
    ): Promise<Event> {
      const [value] = await drizzle
        .select()
        .from(events)
        .where(and(eq(events.runId, runId), eq(events.eventId, eventId)))
        .limit(1);

      if (!value) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`);
      }

      value.eventData ||= value.eventDataJson;
      const parsed = EventSchema.parse(compact(value));
      const resolveData = params?.resolveData ?? 'all';
      return stripEventDataRefs(parsed, resolveData);
    },
    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      const limit = params.pagination?.limit ?? getMaxEventsPerRun();
      const sortOrder = params.pagination?.sortOrder ?? 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const resolveData = params.resolveData ?? 'all';
      const data: Event[] = [];
      let cursor = params.pagination?.cursor;
      let hasMore = false;

      do {
        const pageLimit =
          params.pagination?.limit === undefined
            ? Math.min(500, limit - data.length)
            : limit;
        const rows = await drizzle
          .select()
          .from(events)
          .where(
            and(
              eq(events.runId, params.runId),
              map(cursor, (value) => order.compare(events.eventId, value))
            )
          )
          .orderBy(order.by)
          .limit(pageLimit + 1);
        const page = rows.slice(0, pageLimit);

        for (const row of page) {
          row.eventData ||= row.eventDataJson;
          const event = EventSchema.parse(compact(row));
          data.push(stripEventDataRefs(event, resolveData));
        }

        cursor = page.at(-1)?.eventId;
        hasMore = rows.length > pageLimit;
      } while (
        params.pagination?.limit === undefined &&
        hasMore &&
        data.length < limit
      );

      return {
        data,
        cursor: data.at(-1)?.eventId ?? null,
        hasMore,
      };
    },
    async listByCorrelationId(params) {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const order =
        sortOrder === 'desc'
          ? { by: desc(events.eventId), compare: lt }
          : { by: events.eventId, compare: gt };
      const all = await drizzle
        .select()
        .from(events)
        .where(
          and(
            eq(events.correlationId, params.correlationId),
            // A correlation id names a step or wait within its run, so an
            // unscoped query matches one event per run that allocated the same
            // id, and the cursor, an event id, cannot tell two such rows
            // apart. Scoped, `(run_id, id)` is the primary key, so it can.
            eq(events.runId, params.runId),
            map(params.pagination?.cursor, (c) =>
              order.compare(events.eventId, c)
            )
          )
        )
        .orderBy(order.by)
        .limit(limit + 1);

      const values = all.slice(0, limit);

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.eventData ||= v.eventDataJson;
          const parsed = EventSchema.parse(compact(v));
          return stripEventDataRefs(parsed, resolveData);
        }),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore: all.length > limit,
      };
    },
  };
}

export function createHooksStorage(drizzle: Drizzle): Storage['hooks'] {
  const { hooks, runs } = Schema;
  const ownerRunIsTerminal = drizzle
    .select({ runId: runs.runId })
    .from(runs)
    .where(
      and(
        eq(runs.runId, hooks.runId),
        inArray(runs.status, TERMINAL_WORKFLOW_RUN_STATUSES)
      )
    );
  const available = or(
    gt(hooks.tokenRetentionUntil, sql`now()`),
    notExists(ownerRunIsTerminal)
  );
  const getByToken = drizzle
    .select()
    .from(hooks)
    .where(and(eq(hooks.token, sql.placeholder('token')), available))
    .limit(1)
    .prepare('workflow_hooks_get_by_token');

  return {
    async get(hookId, params) {
      const [value] = await drizzle
        .select()
        .from(hooks)
        .where(and(eq(hooks.hookId, hookId), available))
        .limit(1);
      if (!value) {
        throw new HookNotFoundError(hookId);
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      parsed.isWebhook ??= true;
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async getByToken(token, params) {
      const [value] = await getByToken.execute({ token });
      if (!value) {
        throw new HookNotFoundError(token);
      }
      value.metadata ||= value.metadataJson;
      const parsed = HookSchema.parse(compact(value));
      parsed.isWebhook ??= true;
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(parsed, resolveData);
    },
    async list(params: ListHooksParams) {
      const limit = params?.pagination?.limit ?? 100;
      const fromCursor = params?.pagination?.cursor;
      const sortOrder = params?.pagination?.sortOrder ?? 'asc';
      const orderFn = sortOrder === 'asc' ? asc : desc;
      const cursorFn = sortOrder === 'asc' ? gt : lt;
      const all = await drizzle
        .select()
        .from(hooks)
        .where(
          and(
            available,
            map(params.runId, (id) => eq(hooks.runId, id)),
            map(fromCursor, (c) => cursorFn(hooks.hookId, c))
          )
        )
        .orderBy(orderFn(hooks.hookId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.metadata ||= v.metadataJson;
          const parsed = HookSchema.parse(compact(v));
          return filterHookData(parsed, resolveData);
        }),
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },
  };
}

export function createStepsStorage(drizzle: Drizzle): Storage['steps'] {
  const { steps } = Schema;

  return {
    get: (async (runId, stepId, params) => {
      const [value] = await drizzle
        .select()
        .from(steps)
        .where(and(eq(steps.runId, runId), eq(steps.stepId, stepId)))
        .limit(1);

      if (!value) {
        throw new WorkflowWorldError(`Step not found: ${stepId}`);
      }
      value.output ||= value.outputJson;
      value.input ||= value.inputJson;
      value.error ||= parseErrorJson(value.errorJson);
      const deserialized = deserializeStepError(compact(value));
      const parsed = StepSchema.parse(deserialized);
      const resolveData = params?.resolveData ?? 'all';
      return filterStepData(parsed, resolveData);
    }) as Storage['steps']['get'],
    list: (async (params) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const all = await drizzle
        .select()
        .from(steps)
        .where(
          and(
            eq(steps.runId, params.runId),
            map(fromCursor, (c) => lt(steps.stepId, c))
          )
        )
        .orderBy(desc(steps.stepId))
        .limit(limit + 1);
      const values = all.slice(0, limit);
      const hasMore = all.length > limit;

      const resolveData = params?.resolveData ?? 'all';
      return {
        data: values.map((v) => {
          v.output ||= v.outputJson;
          v.input ||= v.inputJson;
          v.error ||= parseErrorJson(v.errorJson);
          const deserialized = deserializeStepError(compact(v));
          const parsed = StepSchema.parse(deserialized);
          return filterStepData(parsed, resolveData);
        }),
        hasMore,
        cursor: values.at(-1)?.stepId ?? null,
      };
    }) as Storage['steps']['list'],
  };
}

function filterStepData(step: Step, resolveData: 'none'): StepWithoutData;
function filterStepData(step: Step, resolveData: 'all'): Step;
function filterStepData(
  step: Step,
  resolveData: ResolveData
): Step | StepWithoutData;
function filterStepData(
  step: Step,
  resolveData: ResolveData
): Step | StepWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = step;

    return { input: undefined, output: undefined, ...rest };
  }
  return step;
}

function filterRunData(
  run: WorkflowRun,
  resolveData: 'none'
): WorkflowRunWithoutData;
function filterRunData(run: WorkflowRun, resolveData: 'all'): WorkflowRun;
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData
): WorkflowRun | WorkflowRunWithoutData;
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData
): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = run;

    return { input: undefined, output: undefined, ...rest };
  }
  return run;
}

function filterHookData(hook: Hook, resolveData: ResolveData): Hook {
  if (resolveData === 'none' && 'metadata' in hook) {
    const { metadata: _, ...rest } = hook;

    return { metadata: undefined, ...rest };
  }
  return hook;
}
