/**
 * In-memory, single-threaded event store.
 *
 * This is a reference implementation of the World storage contract: the same
 * event → entity state machine `@workflow/world-local` implements on the
 * filesystem, minus every mechanism that exists purely to make that state
 * machine safe against concurrent processes (exclusive-create claim files,
 * per-entity file locks, staged/promoted hook events, canonical event-id
 * pinning after a crash). A scenario runs exactly one delivery at a time in
 * one process, so those races cannot occur here and their absence is what
 * keeps this file small enough to audit.
 *
 * What is deliberately *kept* is every validation that rejects an event:
 * terminal-run guards, step lifecycle ordering, hook token uniqueness, wait
 * duplication. Those rejections are the observable contract the runtime is
 * written against, so a simulation that relaxed them would agree with the
 * runtime about nothing interesting.
 */

import {
  EntityConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type AnyEventRequest,
  type CreateEventParams,
  type Event,
  type EventResult,
  type Hook,
  type HookResumeContext,
  isChildEntityCreationEvent,
  isHookEventRequiringExistence,
  isStepEventType,
  isTerminalRunEventType,
  isTerminalStepEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  type PaginatedResponse,
  type PaginationOptions,
  type ResolveData,
  requireEventSlot,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type Step,
  type Storage,
  stripEventDataRefs,
  type Wait,
  type WorkflowRun,
} from '@workflow/world';
import { type IdFactory } from './ids.js';

/** Per-run event ceiling reported on run responses, mirroring the other worlds. */
const MAX_EVENTS_PER_RUN = 25_000;

const DEFAULT_PAGE_LIMIT = 20;

/**
 * How many of a run's most recent event ids the count guard keeps.
 *
 * Mirrors workflow-server's `RUN_EVENT_INDEX_WINDOW`. The window is what makes
 * the guard one-sided: a hole deeper than this cannot be proven, so the
 * comparison reports `indeterminate` and the write is allowed through.
 */
const RUN_EVENT_INDEX_WINDOW = 16;

/**
 * Sim-internal `events.create` params, supplied by the world facade rather than
 * by the runtime under test.
 */
interface SimCreateParams {
  /**
   * The log this write was decided against, or absent when the write did not
   * come from a replay context at all (an out-of-band writer, or a store driven
   * directly by a unit test).
   *
   * Reconstructed by the world facade from the pages the writer read, because
   * the runtime no longer states it: `@workflow/core` describes its snapshot as
   * a slot count, and the sim mints ULIDs, so there is nothing on the wire for
   * the fence to read. The reconstruction is the same derivation the client
   * used to make — the newest loaded position, and how many events sit at or
   * below it — which is what lets the fence spot a hole *behind* the watermark
   * that no comparison against the watermark alone can see.
   *
   * See `SimStoreOptions.preconditionGuard` and `SimWorldOptions.countGuard`.
   */
  snapshot?: LoadedSnapshot;
}

/** What a replay-context writer had loaded when it decided to write. */
export interface LoadedSnapshot {
  /** Slot of the newest loaded event. */
  maxSlot: number;
  /** How many loaded events sit at or below {@link maxSlot}. */
  count: number;
}

/** Per run: the tail of the log, for the count guard. See `countRecordedAtOrBelow`. */
interface RunEventIndex {
  recentEventIds: string[];
  total: number;
}

/**
 * How many events the log holds at or below the caller's watermark, or `null`
 * when the retained window cannot prove it.
 *
 * Ported from workflow-server's `countRecordedAtOrBelow`, including its
 * exactness argument: pruning always drops the oldest id, so `total - above` is
 * exact whenever the window still reaches back past the snapshot. The one case
 * it refuses to evaluate is a pruned window whose every retained id is above
 * the snapshot — the dropped ids may have been above it too.
 */
function countRecordedAtOrBelow(
  index: RunEventIndex,
  maxSlot: number
): number | null {
  const above = index.recentEventIds.filter(
    (id) => requireEventSlot(id) > maxSlot
  ).length;
  const pruned = index.total > index.recentEventIds.length;
  if (pruned && above === index.recentEventIds.length) return null;
  return index.total - above;
}

export interface SimStoreOptions {
  now(): number;
  ids: IdFactory;
  /**
   * Enforce the optimistic-concurrency precondition guard described in
   * `WorldCapabilities.preconditionGuard`: reject a replay-context write whose
   * snapshot predates the newest externally-originated event.
   *
   * Off by default. Turning it on is the point of a simulation — it lets a
   * scenario check that the runtime recovers from a 412 fence — but it also
   * changes which runtime fast paths engage, so it is never implicit.
   */
  preconditionGuard?: boolean;
  /**
   * Also enforce workflow-server's *count* guard: reject a write whose caller
   * loaded fewer events at or below its own watermark than the log actually
   * holds there.
   *
   * This is the half of the fence the watermark cannot express. A high-water
   * mark answers "is there anything newer than my snapshot?", which sees a log
   * truncated at the end; the count answers "is anything missing *behind* my
   * snapshot?", which is the hole two concurrent writers actually produce.
   *
   * Requires `preconditionGuard`: it counts against the same watermark. Both
   * halves read `SimCreateParams.snapshot`, which the world facade
   * reconstructs; see `SimWorldOptions.countGuard`.
   */
  countGuard?: boolean;
  /** Invoked after every successful append, before the create call returns. */
  onEvent?(event: Event): void;
  /** Invoked when a read was served an incomplete log. */
  onStaleRead?(read: StaleRead): void;
}

/** One event-log read that did not see everything the log already held. */
export interface StaleRead {
  /** The oldest event the read did not see. */
  eventId: string;
  /** How many committed events the read did not see, that one included. */
  hidden: number;
  /**
   * The read was cut short at `eventId` rather than served around it: a
   * replica that is behind, not one that is wrong.
   */
  truncated: boolean;
}

export interface SimStore extends Storage {
  /**
   * Load a previously committed log into an empty store, verbatim — same
   * event ids, same timestamps — and fold the entity state back out of it.
   *
   * This is the "cold start" primitive: it reconstructs the durable state a
   * fresh process would find, without re-validating writes that were already
   * accepted once. Seeded events are deliberately not reported to `onEvent`,
   * so a trace of the seeded world shows only what the replay newly derives.
   */
  seedFromLog(log: readonly Event[]): void;
  /**
   * Hide the *next* event appended from the following `reads` event-log reads.
   *
   * This models one concurrent writer precisely. Under real concurrency two
   * read stops at the withheld event, modeling a lagging replica that has not
   * caught up yet.
   */
  withholdNextEvent(reads?: number): void;
  /** Every event ever appended, in log order. */
  allEvents(runId?: string): Event[];
  /**
   * The same events in the order they were *committed*, which is the order this
   * array was appended to. Differs from `allEvents` exactly when a write was
   * minted before another and committed after it — so the two together are what
   * `log.monotonic-order` compares.
   */
  allEventsInCommitOrder(runId?: string): Event[];
  allRuns(): WorkflowRun[];
  allSteps(runId?: string): Step[];
  allHooks(runId?: string): Hook[];
  allWaits(runId?: string): Wait[];
  hookByToken(token: string): Hook | undefined;
}

/** Brand check that survives a swapped global constructor (see `clock.ts`). */
function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  // Deliberately not `instanceof`: a Date minted under one virtual clock must
  // still read as a Date under the next one. Getting this wrong turns a Date
  // into `{}` (it has no own enumerable properties) far from the actual bug.
  if (isDate(value)) return new Date((value as Date).getTime()) as unknown as T;
  if (value instanceof Uint8Array) return value as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out as T;
  }
  return value;
}

function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

function decodeCursor(
  cursor: string | undefined
): { timeMs: number; id: string | null } | null {
  if (!cursor) return null;
  const [time, id] = cursor.split('|');
  return { timeMs: new Date(time).getTime(), id: id || null };
}

/**
 * Shared pagination over an in-memory collection, matching world-local's
 * `(createdAt, id)` ordering and `"<iso>|<id>"` cursor format exactly. The
 * runtime pages through event logs with these semantics, so a divergence here
 * would show up as phantom replay divergence rather than as a store bug.
 */
function paginate<T>(
  items: readonly T[],
  opts: {
    pagination?: PaginationOptions;
    defaultSortOrder?: 'asc' | 'desc';
    getCreatedAt(item: T): Date;
    getId(item: T): string;
  }
): PaginatedResponse<T> {
  const sortOrder =
    opts.pagination?.sortOrder ?? opts.defaultSortOrder ?? 'desc';
  const limit = opts.pagination?.limit ?? DEFAULT_PAGE_LIMIT;
  const cursor = decodeCursor(opts.pagination?.cursor);

  const sorted = [...items].sort((a, b) => {
    const at = opts.getCreatedAt(a).getTime();
    const bt = opts.getCreatedAt(b).getTime();
    if (at !== bt) return sortOrder === 'asc' ? at - bt : bt - at;
    const ai = opts.getId(a);
    const bi = opts.getId(b);
    return sortOrder === 'asc' ? ai.localeCompare(bi) : bi.localeCompare(ai);
  });

  const afterCursor = cursor
    ? sorted.filter((item) => {
        const t = opts.getCreatedAt(item).getTime();
        if (sortOrder === 'asc') {
          if (t < cursor.timeMs) return false;
          if (t === cursor.timeMs && cursor.id) {
            return opts.getId(item).localeCompare(cursor.id) > 0;
          }
          return t > cursor.timeMs;
        }
        if (t > cursor.timeMs) return false;
        if (t === cursor.timeMs && cursor.id) {
          return opts.getId(item).localeCompare(cursor.id) < 0;
        }
        return t < cursor.timeMs;
      })
    : sorted;

  const hasMore = afterCursor.length > limit;
  const page = hasMore ? afterCursor.slice(0, limit) : afterCursor;
  const last = page[page.length - 1];
  return {
    data: page.map(clone),
    cursor: last
      ? encodeCursor(opts.getCreatedAt(last), opts.getId(last))
      : null,
    hasMore,
  };
}

/** What one event changed. Empty when the event owns no entity. */
interface AppliedEntities {
  run?: WorkflowRun;
  step?: Step;
  hook?: Hook;
  wait?: Wait;
}

export function createSimStore(options: SimStoreOptions): SimStore {
  const { ids, now: nowMs } = options;

  const events: Event[] = [];
  const runs = new Map<string, WorkflowRun>();
  /** Keyed `${runId}:${stepId}`. */
  const steps = new Map<string, Step>();
  const hooks = new Map<string, Hook>();
  /** Live token → hookId. A disposed or run-terminated hook releases its token. */
  const tokenOwners = new Map<string, string>();
  /** Keyed `${runId}:${correlationId}`. */
  const waits = new Map<string, Wait>();
  /** hookIds that have been explicitly disposed; disposal is permanent. */
  const disposedHooks = new Set<string>();
  /**
   * Per run: ULID time of the newest externally-originated event. Only read
   * when `preconditionGuard` is on. See `SimCreateParams.snapshot`.
   */
  const externalWriteMarker = new Map<string, number>();
  /**
   * Per run: the tail of the log, for the count guard. Records *every* event,
   * replay-origin included — the corruption it guards against is one replay
   * racing another, which the out-of-band marker cannot see by construction.
   */
  const runEventIndex = new Map<string, RunEventIndex>();

  /** Reads to withhold the next appended event from, once it is appended. */
  let armedWithhold: number | undefined;
  /** The withheld event and how many more reads must not see it. */
  let withheld: { eventId: string; remaining: number } | undefined;

  /**
   * Serve a read, minus any event currently being withheld. Reads outside a
   * withhold window get the real log.
   *
   * A withheld event cuts the read short there, leaving a prefix of the real
   * log: short, but never self-contradictory.
   */
  function applyWithhold(source: readonly Event[]): readonly Event[] {
    if (!withheld || withheld.remaining <= 0) return source;
    const { eventId } = withheld;
    withheld.remaining--;
    if (withheld.remaining <= 0) withheld = undefined;
    const visible = source.filter((e) => e.eventId < eventId);
    const hidden = source.length - visible.length;
    if (hidden > 0) {
      options.onStaleRead?.({ eventId, hidden, truncated: true });
    }
    return visible;
  }

  const stepKey = (runId: string, stepId: string) => `${runId}:${stepId}`;
  const waitKey = (runId: string, correlationId: string) =>
    `${runId}:${correlationId}`;

  function eventPosition(runId: string): Pick<Event, 'eventId' | 'createdAt'> {
    return {
      eventId: slotToEventId(committedSlot(runId) + 1),
      createdAt: new Date(nowMs()),
    };
  }

  function committedSlot(runId: string): number {
    return events
      .filter((event) => event.runId === runId)
      .reduce((max, event) => Math.max(max, requireEventSlot(event.eventId)), 0);
  }

  function recordInIndex(event: Event): void {
    const index = runEventIndex.get(event.runId) ?? {
      recentEventIds: [],
      total: 0,
    };
    index.recentEventIds.push(event.eventId);
    // Keep the window in mint order, so "oldest id" and "oldest event" stay the
    // same thing — `countRecordedAtOrBelow`'s exactness argument depends on it.
    index.recentEventIds.sort((a, b) => a.localeCompare(b));
    if (index.recentEventIds.length > RUN_EVENT_INDEX_WINDOW) {
      index.recentEventIds.shift();
    }
    index.total++;
    runEventIndex.set(event.runId, index);
  }

  function append(event: Event): Event {
    events.push(event);
    recordInIndex(event);
    if (armedWithhold !== undefined) {
      withheld = { eventId: event.eventId, remaining: armedWithhold };
      armedWithhold = undefined;
    }
    options.onEvent?.(event);
    return event;
  }

  function requireRun(runId: string): WorkflowRun {
    const run = runs.get(runId);
    if (!run) throw new WorkflowRunNotFoundError(runId);
    return run;
  }

  function resumeContextFor(run: WorkflowRun): HookResumeContext {
    const ctx = run.executionContext ?? {};
    return {
      deploymentId: run.deploymentId,
      workflowName: run.workflowName,
      runSpecVersion: run.specVersion,
      ...(typeof ctx.workflowCoreVersion === 'string'
        ? { workflowCoreVersion: ctx.workflowCoreVersion }
        : {}),
      ...(ctx.traceCarrier && typeof ctx.traceCarrier === 'object'
        ? {
            traceCarrier: ctx.traceCarrier as HookResumeContext['traceCarrier'],
          }
        : {}),
      ...(run.encryptionPublicKey
        ? { encryptionPublicKey: run.encryptionPublicKey }
        : {}),
    };
  }

  /**
   * Release the hooks and waits a terminated run owned. Mirrors the other
   * worlds: once a run is terminal its hooks can never be resumed, so their
   * tokens become available again.
   */
  function releaseRunResources(runId: string) {
    for (const [hookId, hook] of hooks) {
      if (hook.runId !== runId) continue;
      if (tokenOwners.get(hook.token) === hookId)
        tokenOwners.delete(hook.token);
      hooks.delete(hookId);
    }
    for (const [key, wait] of waits) {
      if (wait.runId === runId) waits.delete(key);
    }
  }

  function eventsForRun(runId: string): Event[] {
    return events.filter((e) => e.runId === runId);
  }

  /**
   * Apply one event to the entity rows, and report what it touched.
   *
   * The single copy of the event → entity state machine. Both paths into the
   * store end here: `create` runs its validation and then calls this, and
   * `seedFromLog` calls it with no validation at all — those events were
   * accepted once already, and re-litigating them would reject legitimate
   * history (a `step_completed` recorded after the run was cancelled, say).
   *
   * So the applier is *total*: an event whose subject is missing is a no-op
   * rather than an error, and refusing anything is the caller's job. Holding
   * both paths to one fold is what keeps a replay from diverging from the run
   * it is checking for a reason that is not the runtime's fault.
   *
   * `at` is the entity timestamp: commit time on the write path; the event's
   * own position time when seeding, where there is no live clock to read.
   */
  function applyEvent(event: Event, at: Date): AppliedEntities {
    const runId = event.runId;
    const data = (event as { eventData?: Record<string, unknown> }).eventData;
    const correlationId = event.correlationId;

    switch (event.eventType) {
      case 'run_created': {
        const run = {
          runId,
          deploymentId: data?.deploymentId as string,
          workflowName: data?.workflowName as string,
          status: 'pending',
          specVersion: event.specVersion,
          executionContext: data?.executionContext as Record<string, unknown>,
          input: data?.input as Uint8Array,
          attributes: (data?.attributes as Record<string, string>) ?? {},
          encryptionPublicKey: data?.encryptionPublicKey as string | undefined,
          createdAt: at,
          updatedAt: at,
        } as WorkflowRun;
        runs.set(runId, run);
        return { run };
      }

      case 'run_started': {
        const existing = runs.get(runId);
        if (!existing) return {};
        // The clears are for the write path, where a restart is a real
        // transition. On a seeded log they are already undefined: a
        // `run_started` never follows a terminal event in a log the write path
        // accepted.
        const run = {
          ...existing,
          status: 'running',
          output: undefined,
          error: undefined,
          completedAt: undefined,
          startedAt: existing.startedAt ?? at,
          updatedAt: at,
        } as WorkflowRun;
        runs.set(runId, run);
        return { run };
      }

      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled': {
        const existing = runs.get(runId);
        if (!existing) return {};
        const run = {
          ...existing,
          status:
            event.eventType === 'run_completed'
              ? 'completed'
              : event.eventType === 'run_failed'
                ? 'failed'
                : 'cancelled',
          output: data?.output as Uint8Array | undefined,
          error: data?.error as Uint8Array | undefined,
          errorCode: data?.errorCode as string | undefined,
          completedAt: at,
          updatedAt: at,
        } as WorkflowRun;
        runs.set(runId, run);
        releaseRunResources(runId);
        return { run };
      }

      case 'attr_set': {
        const existing = runs.get(runId);
        if (!existing) return {};
        const attributes = { ...existing.attributes };
        for (const change of (data?.changes ?? []) as {
          key: string;
          value: string | null;
        }[]) {
          if (change.value === null) delete attributes[change.key];
          else attributes[change.key] = change.value;
        }
        const run = { ...existing, attributes, updatedAt: at } as WorkflowRun;
        runs.set(runId, run);
        return { run };
      }

      case 'step_created': {
        if (!correlationId) return {};
        const step: Step = {
          runId,
          stepId: correlationId,
          stepName: data?.stepName as string,
          status: 'pending',
          input: data?.input as Uint8Array,
          attempt: 0,
          createdAt: at,
          updatedAt: at,
          specVersion: event.specVersion,
        };
        steps.set(stepKey(runId, correlationId), step);
        return { step };
      }

      case 'step_started':
      case 'step_completed':
      case 'step_failed':
      case 'step_retrying': {
        if (!correlationId) return {};
        const key = stepKey(runId, correlationId);
        const existing = steps.get(key);
        if (!existing) return {};
        const step: Step =
          event.eventType === 'step_started'
            ? {
                ...existing,
                status: 'running',
                startedAt: existing.startedAt ?? at,
                attempt: existing.attempt + 1,
                retryAfter: undefined,
                updatedAt: at,
              }
            : event.eventType === 'step_completed'
              ? {
                  ...existing,
                  status: 'completed',
                  output: data?.result as Uint8Array,
                  completedAt: at,
                  updatedAt: at,
                }
              : event.eventType === 'step_failed'
                ? {
                    ...existing,
                    status: 'failed',
                    error: data?.error as Uint8Array,
                    completedAt: at,
                    updatedAt: at,
                  }
                : {
                    ...existing,
                    status: 'pending',
                    error: data?.error as Uint8Array,
                    retryAfter: data?.retryAfter as Date | undefined,
                    updatedAt: at,
                  };
        steps.set(key, step);
        return { step };
      }

      case 'hook_created': {
        if (!correlationId) return {};
        const token = data?.token as string;
        const owningRun = runs.get(runId);
        const hook: Hook = {
          runId,
          hookId: correlationId,
          token,
          metadata: data?.metadata as Uint8Array | undefined,
          ownerId: 'sim-owner',
          projectId: 'sim-project',
          environment: 'sim',
          createdAt: at,
          specVersion: event.specVersion,
          isWebhook: (data?.isWebhook as boolean) ?? false,
          isSystem: (data?.isSystem as boolean) ?? false,
          ...(owningRun ? { resumeContext: resumeContextFor(owningRun) } : {}),
        };
        hooks.set(correlationId, hook);
        tokenOwners.set(token, correlationId);
        return { hook };
      }

      // A delivered payload changes no row of its own; the hook is reported
      // back so the caller can return it.
      case 'hook_received':
        return correlationId ? { hook: hooks.get(correlationId) } : {};

      case 'hook_disposed': {
        if (!correlationId) return {};
        disposedHooks.add(correlationId);
        const existing = hooks.get(correlationId);
        if (existing && tokenOwners.get(existing.token) === correlationId) {
          tokenOwners.delete(existing.token);
        }
        hooks.delete(correlationId);
        return {};
      }

      case 'wait_created': {
        if (!correlationId) return {};
        const key = waitKey(runId, correlationId);
        const wait: Wait = {
          waitId: key,
          runId,
          status: 'waiting',
          resumeAt: data?.resumeAt as Date | undefined,
          createdAt: at,
          updatedAt: at,
          specVersion: event.specVersion,
        };
        waits.set(key, wait);
        return { wait };
      }

      case 'wait_completed': {
        if (!correlationId) return {};
        const key = waitKey(runId, correlationId);
        const existing = waits.get(key);
        if (!existing) return {};
        const wait: Wait = {
          ...existing,
          status: 'completed',
          completedAt: at,
          updatedAt: at,
        };
        waits.set(key, wait);
        return { wait };
      }

      default:
        return {};
    }
  }

  async function create(
    runIdArg: string | null,
    data: AnyEventRequest,
    params?: CreateEventParams
  ): Promise<EventResult> {
    // Event and entity timestamps are both assigned at commit.
    const now = new Date(nowMs());
    const internal = params as
      | (CreateEventParams & SimCreateParams)
      | undefined;
    const resolveData: ResolveData = params?.resolveData ?? 'all';
    const specVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

    let runId: string;
    if (data.eventType === 'run_created' && !runIdArg) {
      runId = ids.runId();
    } else if (!runIdArg) {
      throw new Error('runId is required for non-run_created events');
    } else {
      runId = runIdArg;
    }
    let position = eventPosition(runId);

    let currentRun = runs.get(runId);

    // ---- Resilient start ---------------------------------------------------
    // A `run_started` carrying creation data may legitimately arrive for a run
    // whose `run_created` write failed: `start()` fires both concurrently and
    // treats a retryable creation failure as recoverable because the queue
    // already accepted the run. Create the run (and a synthetic `run_created`)
    // from the queued payload.
    if (data.eventType === 'run_started' && !currentRun && data.eventData) {
      const seed = data.eventData;
      if (seed.deploymentId && seed.workflowName && seed.input !== undefined) {
        const synthetic = {
          eventType: 'run_created',
          runId,
          ...position,
          specVersion,
          eventData: {
            deploymentId: seed.deploymentId,
            workflowName: seed.workflowName,
            input: seed.input,
            executionContext: seed.executionContext,
            attributes: seed.attributes,
            encryptionPublicKey: seed.encryptionPublicKey,
          },
        } as Event;
        currentRun = applyEvent(synthetic, now).run;
        append(synthetic);
        // The synthetic is committed first, so the requested row takes the next
        // position and sorts after it.
        position = eventPosition(runId);
      }
    }

    if (
      (data.eventType === 'run_failed' || data.eventType === 'attr_set') &&
      !currentRun
    ) {
      throw new WorkflowRunNotFoundError(runId);
    }

    // ---- Optimistic-concurrency fence -------------------------------------
    // Two independent predicates, both evaluated here and both atomic with the
    // append below (there is no await between them and it), mirroring
    // workflow-server's handler. The first is a high-water mark; the second is
    // a count. They fail on different shapes, and only together do they cover
    // both halves of a two-writer race.
    const snapshot = internal?.snapshot;
    if (options.preconditionGuard && snapshot) {
      const marker = externalWriteMarker.get(runId);
      if (marker !== undefined && snapshot.maxSlot < marker) {
        throw new PreconditionFailedError(
          `Run "${runId}" changed out of band since the caller's snapshot`
        );
      }

      // The count guard. `recorded > snapshot.count` means the log holds an
      // event at or below the caller's own watermark that the caller never
      // loaded: a hole, which the marker comparison above passes by
      // construction because the missing event is *older* than the newest one
      // the caller did see. A `null` count is indeterminate (the window pruned
      // past the snapshot) and is never treated as stale — the guard is
      // deliberately one-sided.
      if (options.countGuard) {
        const index = runEventIndex.get(runId);
        const recorded = index
            ? countRecordedAtOrBelow(index, snapshot.maxSlot)
          : null;
        if (recorded !== null && recorded > snapshot.count) {
          throw new PreconditionFailedError(
            `Run "${runId}" holds ${recorded} events at or below the caller's ` +
              `watermark, but the caller loaded ${snapshot.count}`
          );
        }
      }
    }

    const createsChildEntity = isChildEntityCreationEvent(data);
    const lazyStepStart =
      createsChildEntity && data.eventType === 'step_started';

    // ---- Terminal-run guards ----------------------------------------------
    if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
      if (
        data.eventType === 'run_cancelled' &&
        currentRun.status === 'cancelled'
      ) {
        // Cancelling an already-cancelled run is idempotent.
        const event = append({
          ...data,
          runId,
          ...position,
          specVersion,
        } as Event);
        return {
          event: stripEventDataRefs(clone(event), resolveData),
          run: clone(currentRun),
          maxEvents: MAX_EVENTS_PER_RUN,
        };
      }
      if (data.eventType === 'run_started') {
        throw new RunExpiredError(
          `Workflow run "${runId}" is already in terminal state "${currentRun.status}"`
        );
      }
      if (isTerminalRunEventType(data.eventType)) {
        throw new EntityConflictError(
          `Cannot transition run from terminal state "${currentRun.status}"`
        );
      }
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

    // ---- Step ordering guards ---------------------------------------------
    let validatedStep: Step | undefined;
    if (
      isStepEventType(data.eventType) &&
      data.eventType !== 'step_created' &&
      data.correlationId
    ) {
      validatedStep = steps.get(stepKey(runId, data.correlationId));
      if (!validatedStep && !lazyStepStart) {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`);
      }
      // A lazy `step_started` is the exactly-once create claim for its step:
      // if the step already exists, another handler won and this caller must
      // not run the body. `EntityConflictError` is what the runtime maps to
      // "skipped".
      if (lazyStepStart && validatedStep) {
        throw new EntityConflictError(
          `Step "${data.correlationId}" already created`
        );
      }
      if (validatedStep) {
        if (isTerminalStepStatus(validatedStep.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`
          );
        }
        if (
          data.eventType === 'step_started' &&
          validatedStep.retryAfter &&
          validatedStep.retryAfter.getTime() > nowMs()
        ) {
          throw new TooEarlyError(
            `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
            {
              retryAfter: Math.ceil(
                (validatedStep.retryAfter.getTime() - nowMs()) / 1000
              ),
            }
          );
        }
        if (currentRun && isTerminalWorkflowRunStatus(currentRun.status)) {
          // A terminal run still accepts the terminal write of a step that was
          // already running when the run ended — that write is how an inline
          // step reports back — but nothing else.
          if (validatedStep.status !== 'running') {
            throw new RunExpiredError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`
            );
          }
        }
      }
    }

    // ---- Hook existence guards --------------------------------------------
    if (isHookEventRequiringExistence(data.eventType) && data.correlationId) {
      if (disposedHooks.has(data.correlationId)) {
        throw new HookNotFoundError(data.correlationId);
      }
      if (!hooks.has(data.correlationId)) {
        throw new HookNotFoundError(data.correlationId);
      }
    }

    let event: Event = {
      ...data,
      runId,
      ...position,
      specVersion,
    } as Event;

    // `run_started`'s eventData is a bootstrap payload for the resilient path
    // above, not log content — the canonical copy lives on `run_created`.
    if (data.eventType === 'run_started' && 'eventData' in event) {
      delete (event as Record<string, unknown>).eventData;
    }

    // ---- Per-event-type validation ----------------------------------------
    // Everything the write path *refuses*. What it does to the entity rows is
    // `applyEvent` below — the same fold the seed path runs.
    switch (data.eventType) {
      case 'run_created': {
        if (runs.has(runId)) {
          throw new EntityConflictError(
            `Workflow run "${runId}" already exists`
          );
        }
        break;
      }

      case 'run_started': {
        if (currentRun?.status === 'running') {
          // Idempotent: a concurrent invocation already started the run. No
          // event is appended — replay must not see two `run_started`.
          return { run: clone(currentRun), maxEvents: MAX_EVENTS_PER_RUN };
        }
        break;
      }

      case 'step_created': {
        if (steps.has(stepKey(runId, data.correlationId))) {
          throw new EntityConflictError(
            `Step "${data.correlationId}" already created`
          );
        }
        break;
      }

      case 'hook_created': {
        const { token } = data.eventData;
        const owner = tokenOwners.get(token);
        if (owner && owner !== data.correlationId) {
          // Someone else holds the token. This is not an error for the
          // *caller* — the workflow needs to observe it and fail its awaited
          // hook — so it is journaled as a `hook_conflict` event instead.
          const conflict = append({
            eventType: 'hook_conflict',
            runId,
            eventId: event.eventId,
            createdAt: now,
            specVersion,
            correlationId: data.correlationId,
            eventData: {
              token,
              conflictingRunId: hooks.get(owner)?.runId,
            },
          } as Event);
          return {
            event: stripEventDataRefs(clone(conflict), resolveData),
            run: currentRun ? clone(currentRun) : undefined,
          };
        }
        if (hooks.has(data.correlationId)) {
          throw new EntityConflictError(
            `Hook "${data.correlationId}" already created`
          );
        }
        // The hook copies a resume context off its run, so that resuming it
        // needs no run read. No run, no hook.
        requireRun(runId);
        break;
      }

      case 'hook_disposed': {
        if (disposedHooks.has(data.correlationId)) {
          throw new EntityConflictError(
            `Hook "${data.correlationId}" already disposed`
          );
        }
        break;
      }

      case 'wait_created': {
        if (waits.has(waitKey(runId, data.correlationId))) {
          throw new EntityConflictError(
            `Wait "${data.correlationId}" already exists`
          );
        }
        break;
      }

      case 'wait_completed': {
        const existing = waits.get(waitKey(runId, data.correlationId));
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
        break;
      }
    }

    // ---- Lazy step creation ------------------------------------------------
    // A `step_started` that carries a payload and finds no step of its own both
    // creates and starts one. The synthetic `step_created` keeps replay honest,
    // because the client's step consumer only flips `hasCreatedEvent` on that
    // event type.
    let stepCreatedLazily = false;
    if (
      data.eventType === 'step_started' &&
      lazyStepStart &&
      !validatedStep &&
      data.eventData
    ) {
      const created = {
        eventType: 'step_created',
        runId,
        ...position,
        specVersion,
        correlationId: data.correlationId,
        eventData: {
          stepName: data.eventData.stepName,
          input: data.eventData.input,
        },
      } as Event;
      applyEvent(created, now);
      append(created);
      stepCreatedLazily = true;

      // The input now lives on the synthetic `step_created`; keep only the
      // metadata on the `step_started` row. The synthetic is committed first,
      // so `step_started` takes the next position.
      const { input: _dropped, ...rest } = data.eventData;
      position = eventPosition(runId);
      event = { ...event, ...position, eventData: rest } as Event;
    }

    // ---- The fold ----------------------------------------------------------
    const { run, step, hook, wait } = applyEvent(event, now);

    event = append(event);

    // Track externally-originated writes for the precondition fence. A write
    // the facade attached no snapshot to did not come from a replay context, so
    // it is exactly the kind of out-of-band change a replaying caller needs to
    // be fenced against.
    //
    // Two details are load-bearing, both copied from workflow-server's
    // `recordOutsideEvent`:
    //
    // - The mark is the event's own slot, not the commit instant. It has to use
    //   the same unit as a caller's newest loaded position or a caller holding
    //   exactly this event would compare as older and 412 forever.
    // - The write is forward-only. Concurrent out-of-band events can commit out
    //   of position order — the whole subject of these scenarios — and letting a
    //   late-committing older event drag the mark backwards would silently
    //   disarm the guard for the newer one.
    if (
      options.preconditionGuard &&
      snapshot === undefined &&
      (data.eventType === 'hook_received' ||
        data.eventType === 'step_completed' ||
        data.eventType === 'step_failed')
    ) {
      const previous = externalWriteMarker.get(runId) ?? 0;
      externalWriteMarker.set(
        runId,
        Math.max(previous, requireEventSlot(event.eventId))
      );
    }

    // ---- Optional inline event delta --------------------------------------
    // All three fields or none of them: `EventResult` is a union of a populated
    // page and an all-`undefined` one, so they travel together as one object
    // rather than three variables the type cannot see are in agreement.
    let deltaPage:
      | { events: Event[]; cursor: string | null; hasMore: boolean }
      | undefined;

    if (data.eventType === 'run_started' && run && !params?.skipPreload) {
      const page = paginate(eventsForRun(runId), {
        pagination: { limit: 1000, sortOrder: 'asc' },
        getCreatedAt: (e) => e.createdAt,
        getId: (e) => e.eventId,
      });
      deltaPage = {
        events: page.data,
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
    } else if (
      isTerminalStepEventType(data.eventType) &&
      typeof params?.sinceCursor === 'string'
    ) {
      const page = paginate(applyWithhold(eventsForRun(runId)), {
        pagination: { cursor: params.sinceCursor, sortOrder: 'asc' },
        getCreatedAt: (e) => e.createdAt,
        getId: (e) => e.eventId,
      });
      deltaPage = {
        events: page.data.map((e) => stripEventDataRefs(e, resolveData)),
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
    }

    const result = {
      event: stripEventDataRefs(clone(event), resolveData),
      run: run ? clone(run) : undefined,
      step: step ? clone(step) : undefined,
      hook: hook ? clone(hook) : undefined,
      wait: wait ? clone(wait) : undefined,
      // `as const`: outside a returned literal there is no contextual type to
      // keep this from widening to `boolean`, and the field is `true | undefined`.
      ...(stepCreatedLazily ? { stepCreated: true as const } : {}),
      ...(run ? { maxEvents: MAX_EVENTS_PER_RUN } : {}),
    };
    // Spread as a whole or not at all, and as a *conditional* rather than an
    // optional spread: the latter widens the three fields to `T | undefined`,
    // which is neither arm of the union.
    return deltaPage ? { ...result, ...deltaPage } : result;
  }

  const storage: SimStore = {
    runs: {
      async get(id: string, params?: { resolveData?: ResolveData }) {
        const run = runs.get(id);
        if (!run) throw new WorkflowRunNotFoundError(id);
        const copy = clone(run);
        if (params?.resolveData === 'none') {
          return { ...copy, input: undefined, output: undefined } as never;
        }
        return copy as never;
      },
      async getMany(
        idList: readonly string[],
        params?: { resolveData?: ResolveData }
      ) {
        return Promise.all(
          idList.map(async (id) =>
            runs.has(id) ? await storage.runs.get(id, params as never) : null
          )
        ) as never;
      },
      async list(params?: {
        workflowName?: string;
        status?: WorkflowRun['status'];
        pagination?: PaginationOptions;
        resolveData?: ResolveData;
      }) {
        let items = [...runs.values()];
        if (params?.workflowName) {
          items = items.filter((r) => r.workflowName === params.workflowName);
        }
        if (params?.status) {
          items = items.filter((r) => r.status === params.status);
        }
        const page = paginate(items, {
          pagination: params?.pagination,
          getCreatedAt: (r) => r.createdAt,
          getId: (r) => r.runId,
        });
        if (params?.resolveData === 'none') {
          return {
            ...page,
            data: page.data.map((r) => ({
              ...r,
              input: undefined,
              output: undefined,
            })),
          } as never;
        }
        return page as never;
      },
    },

    steps: {
      async get(
        runId: string,
        stepId: string,
        params?: { resolveData?: ResolveData }
      ) {
        const found = steps.get(stepKey(runId, stepId));
        if (!found) throw new WorkflowWorldError(`Step "${stepId}" not found`);
        const copy = clone(found);
        if (params?.resolveData === 'none') {
          return { ...copy, input: undefined, output: undefined } as never;
        }
        return copy as never;
      },
      async list(params: {
        runId: string;
        pagination?: PaginationOptions;
        resolveData?: ResolveData;
      }) {
        const items = [...steps.values()].filter(
          (s) => s.runId === params.runId
        );
        const page = paginate(items, {
          pagination: params.pagination,
          getCreatedAt: (s) => s.createdAt,
          getId: (s) => s.stepId,
        });
        if (params.resolveData === 'none') {
          return {
            ...page,
            data: page.data.map((s) => ({
              ...s,
              input: undefined,
              output: undefined,
            })),
          } as never;
        }
        return page as never;
      },
    },

    events: {
      create: create as Storage['events']['create'],
      async get(runId, eventId, params) {
        const found = events.find(
          (e) => e.runId === runId && e.eventId === eventId
        );
        if (!found)
          throw new Error(`Event ${eventId} in run ${runId} not found`);
        return stripEventDataRefs(clone(found), params?.resolveData ?? 'all');
      },
      async list(params) {
        const page = paginate(applyWithhold(eventsForRun(params.runId)), {
          pagination: params.pagination,
          defaultSortOrder: 'asc',
          getCreatedAt: (e) => e.createdAt,
          getId: (e) => e.eventId,
        });
        const resolve = params.resolveData ?? 'all';
        return {
          ...page,
          data: page.data.map((e) => stripEventDataRefs(e, resolve)),
        };
      },
      async listByCorrelationId(params) {
        const page = paginate(
          events.filter((e) => e.correlationId === params.correlationId),
          {
            pagination: params.pagination,
            defaultSortOrder: 'asc',
            getCreatedAt: (e) => e.createdAt,
            getId: (e) => e.eventId,
          }
        );
        const resolve = params.resolveData ?? 'all';
        return {
          ...page,
          data: page.data.map((e) => stripEventDataRefs(e, resolve)),
        };
      },
    },

    hooks: {
      async get(hookId) {
        const found = hooks.get(hookId);
        if (!found) throw new HookNotFoundError(hookId);
        return clone(found);
      },
      async getByToken(token) {
        const hookId = tokenOwners.get(token);
        const found = hookId ? hooks.get(hookId) : undefined;
        if (!found) throw new HookNotFoundError(token);
        return clone(found);
      },
      async list(params) {
        const items = [...hooks.values()].filter(
          (h) => !params.runId || h.runId === params.runId
        );
        return paginate(items, {
          pagination: params.pagination,
          getCreatedAt: (h) => h.createdAt,
          getId: (h) => h.hookId,
        });
      },
    },

    withholdNextEvent(reads = 1) {
      armedWithhold = reads;
    },

    seedFromLog(log) {
      for (const event of log) {
        const seeded = clone(event) as Event;
        events.push(seeded);
        recordInIndex(seeded);
        // The event's own position time is the only clock a seeded row can
        // have: the live one belongs to whenever this world was built.
        applyEvent(seeded, seeded.createdAt);
      }
    },

    // Log order and commit order are the same: positions are assigned at commit.
    allEvents: (runId) =>
      (runId ? eventsForRun(runId) : events)
        .map(clone)
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.eventId.localeCompare(b.eventId)
        ),
    allEventsInCommitOrder: (runId) =>
      (runId ? eventsForRun(runId) : events).map(clone),
    allRuns: () => [...runs.values()].map(clone),
    allSteps: (runId) =>
      [...steps.values()].filter((s) => !runId || s.runId === runId).map(clone),
    allHooks: (runId) =>
      [...hooks.values()].filter((h) => !runId || h.runId === runId).map(clone),
    allWaits: (runId) =>
      [...waits.values()].filter((w) => !runId || w.runId === runId).map(clone),
    hookByToken: (token) => {
      const hookId = tokenOwners.get(token);
      const found = hookId ? hooks.get(hookId) : undefined;
      return found ? clone(found) : undefined;
    },
  };

  return storage;
}
