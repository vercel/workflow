/**
 * The simulation World.
 *
 * Three things make it different from a normal World implementation:
 *
 * 1. **Every method is a call point.** Each call is wrapped so a scenario can
 *    stop it `before` it starts and `after` its effect is committed but
 *    *before* the awaiting caller is resumed. That second window is the whole
 *    reason this package exists: it is what lets a scenario say "the hook
 *    arrives after `step_started` is durable and before the workflow gets
 *    control back" and have it be a fact rather than a race it won by luck.
 *
 * 2. **Every call is attributed to a writer.** The orchestrator, each step
 *    body, and the scenario acting from outside are separately named and
 *    separately steerable, because "several writers appending to one log with
 *    no serializable isolation between them" is the property under test.
 *
 * 3. **Nothing happens on its own.** The queue only records messages and the
 *    clock only moves when the scheduler moves it, so the sequence of world
 *    calls is a pure function of the scenario.
 *
 * Watches do not fire for calls made from inside another watch's action.
 * Without that rule, a watch on `events.create` would re-trigger on the
 * `hook_received` it just wrote, and any scenario using `deliverHook` would
 * recurse forever.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Event,
  getQueueTopicPrefix,
  type QueuePayload,
  requireEventSlot,
  SPEC_VERSION_CURRENT,
  type World,
} from '@workflow/world';
import { createVirtualClock, type VirtualClock } from './clock.js';
import { createIdFactory, type IdFactory } from './ids.js';
import { createSimQueue, type DirectHandler, type SimQueue } from './queue.js';
import {
  createSimStore,
  type LoadedSnapshot,
  type MintedEvent,
  type SimStore,
} from './store.js';
import { createSimStreamer, type SimStreamer } from './streams.js';
import type {
  CallContext,
  CallMatch,
  ObservedPoint,
  RejectedCall,
  ScenarioApi,
  TraceEntry,
  WorldCallName,
  WorldSnapshot,
  WriterId,
} from './types.js';

export const WORKFLOW_QUEUE_PREFIX = getQueueTopicPrefix('workflow');

/**
 * A one-shot (or repeating) callback attached to a call point. Internal: a
 * scenario expresses points through writers, and `Watch` is what those compile
 * down to.
 */
export interface Watch {
  match: CallMatch;
  action: (ctx: CallContext, api: ScenarioApi) => void | Promise<void>;
  options: {
    /** Fire on the nth match only (1-based). Defaults to 1. */
    nth?: number;
    /** Fire on every match instead of just one. Overrides `nth`. */
    every?: boolean;
    label?: string;
  };
}

/**
 * How many call points to remember for level-triggered waiting. Generous: a
 * scenario runs a few hundred calls, and the bound exists only so a runaway
 * workflow cannot grow the array without limit before its budget stops it.
 */
const MAX_HISTORY = 20_000;

export interface SimWorldOptions {
  clock?: VirtualClock;
  deploymentId?: string;
  /** See `SimStoreOptions.preconditionGuard`. */
  preconditionGuard?: boolean;
  /**
   * Also enforce the count half of the fence (see `SimStoreOptions.countGuard`).
   *
   * Production arms both halves, so this tracks `preconditionGuard` rather than
   * being opted into per scenario. A run with the fence on and the count off
   * would be a world that exists nowhere.
   */
  countGuard?: boolean;
  /**
   * Assign log positions at commit rather than at the handler boundary, so the
   * log is append-only and no read can be contradicted by a later one. See
   * `SimStoreOptions.appendOnlyLog` for what that buys and what it costs.
   *
   * The boundary reservation still happens — `reservePosition` and everything
   * a scenario hangs off it work unchanged. It just stops being binding: a held
   * write that nothing overtook keeps the position it reserved, and one that
   * was overtaken takes the tail when it lands.
   */
  appendOnlyLog?: boolean;
}

export interface SimWorld extends World {
  clock: VirtualClock;
  ids: IdFactory;
  store: SimStore;
  simQueue: SimQueue;
  streamer: SimStreamer;
  snapshot: WorldSnapshot;
  trace: TraceEntry[];

  registerHandler(prefix: string, handler: DirectHandler): void;
  /** Attach a callback to a call point. Returns a disposer. */
  addWatch(watch: Watch): () => void;
  /** Failures thrown by watch actions; swallowed at the call site, reported here. */
  watchErrors(): string[];
  /** Supply the API object handed to watch actions. */
  setScenarioApi(resolve: () => ScenarioApi): void;
  /**
   * Run `fn` as the scenario acting from outside the run: attributed to the
   * `external` writer, and not itself a call point.
   */
  asExternal<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Take a log position in `runId` now, to be used by a write that happens
   * later.
   *
   * The scenario's own calls are not call points (see `fireWatches`), so a script
   * cannot hold *itself* between taking a position and committing the way it
   * holds a writer. This pair is how it states the same thing directly: reserve the
   * position, do whatever should observe the log without it, then run the write
   * inside `withReservedPosition` so it lands where it was reserved.
   */
  reservePosition(runId: string): MintedEvent;
  /** Run `fn` with the next `events.create` taking `position` instead of minting. */
  withReservedPosition<T>(
    position: MintedEvent,
    fn: () => Promise<T>
  ): Promise<T>;
  pushTrace(entry: TraceInput): void;
  /** Total intercepted world calls so far. */
  callCount(): number;
  /** Every call point reached so far, in order. Backs level-triggered waiting. */
  callHistory(): readonly ObservedPoint[];
  /** Every intercepted call that threw. */
  rejections(): readonly RejectedCall[];
}

/** A trace entry without the fields the world stamps on (seq, time, depth). */
type TraceInput =
  | { kind: 'event'; event: Event; writer?: WriterId }
  | { kind: 'hold'; label: string; inside: string; writer?: WriterId }
  | { kind: 'note' | 'delivery' | 'warn'; message: string }
  | { kind: 'check'; name: string; ok: boolean };

/** Any async world method. */
type AsyncFn = (...args: never[]) => Promise<unknown>;

export function createSimWorld(options: SimWorldOptions = {}): SimWorld {
  const clock = options.clock ?? createVirtualClock();
  const ids = createIdFactory(() => clock.now());
  const deploymentId = options.deploymentId ?? 'dpl_sim';

  const trace: TraceEntry[] = [];
  /**
   * Whether *this* call chain is scenario-originated: set inside an `asExternal`
   * block, i.e. the scenario is the one calling, so the call is attributed to
   * `external` and is not itself a call point.
   *
   * Async-context-scoped rather than a plain counter, because `asExternal`
   * brackets whole operations — `scenario.ts` wraps all of `resumeHook`, which
   * spans several awaits. A counter is a global flag for that whole window, so
   * a step body committing concurrently gets read as the scenario's own call:
   * attributed `external`, skipped by `fireWatches` (a `runTo` armed on it waits
   * out its 5s watchdog instead), and left out of the count guard's loaded-set
   * bookkeeping. `attr-from-step-body` showed this as `ext` on the `probe`
   * step's own `step_completed`, in the one scenario whose subject is the
   * writer column.
   *
   * Deliberately *not* set for the duration of a watch action — see
   * `fireWatches`. A held action outlives the call it fired from, and a flag
   * held that long would silence every other writer.
   */
  const externalCtx = new AsyncLocalStorage<true>();
  const isExternal = () => externalCtx.getStore() === true;
  /** Set by `withReservedPosition`; consumed by the next `events.create`. */
  let reservedPosition: MintedEvent | undefined;
  let callSeq = 0;
  let traceSeq = 0;

  const history: ObservedPoint[] = [];
  const rejected: RejectedCall[] = [];

  const pushTrace = (entry: TraceInput): void => {
    trace.push({
      ...entry,
      seq: traceSeq++,
      atMs: clock.now(),
      depth: isExternal() ? 1 : 0,
    } as TraceEntry);
  };

  const store = createSimStore({
    now: () => clock.now(),
    ids,
    preconditionGuard: options.preconditionGuard,
    countGuard: options.countGuard,
    appendOnlyLog: options.appendOnlyLog,
    // Fires synchronously inside `events.create`, so it runs in that call's
    // async context and `isExternal()` still describes who is writing.
    onEvent: (event) =>
      pushTrace({ kind: 'event', event, writer: writerOfEvent(event) }),
    // Two different faults, and the trace should not blur them: one read
    // around a committed event, the other stopped before it.
    onStaleRead: ({ eventId, hidden, truncated }) =>
      pushTrace({
        kind: 'warn',
        message: truncated
          ? `lagging read: log cut short at ${eventId}; ${hidden} committed event(s) not yet visible`
          : `stale read: committed event ${eventId} withheld from this event-log read`,
      }),
  });

  const simQueue = createSimQueue({
    now: () => clock.now(),
    ids,
    deploymentId,
  });
  const streamer = createSimStreamer();

  const snapshot: WorldSnapshot = {
    nowMs: () => clock.now(),
    runs: () => store.allRuns(),
    run: (runId) => store.allRuns().find((r) => r.runId === runId),
    events: (runId) => store.allEvents(runId),
    steps: (runId) => store.allSteps(runId),
    hooks: (runId) => store.allHooks(runId),
    waits: (runId) => store.allWaits(runId),
    pendingMessages: () => simQueue.view(),
    rejections: () => [...rejected],
  };

  // -------------------------------------------------------------------------
  // Writer attribution
  // -------------------------------------------------------------------------

  /** `step//./workflows/orders//reserveInventory` -> `reserveInventory`. */
  const shortStepName = (name: string): string => {
    const cut = name.lastIndexOf('//');
    return cut === -1 ? name : name.slice(cut + 2);
  };

  /** Resolve a stepId (== the event's correlationId) to its short name. */
  const stepNameOf = (
    runId: string | undefined,
    stepId: string | undefined
  ): string | undefined => {
    if (!stepId) return undefined;
    const step = store
      .allSteps(runId)
      .find((candidate) => candidate.stepId === stepId);
    return step ? shortStepName(step.stepName) : undefined;
  };

  /**
   * Which writer is responsible for an event.
   *
   * Everything the *scenario* does is `external` — that check comes first,
   * because a `run_cancelled` from an operator and a `run_cancelled` from the
   * runtime are the same event type written by very different writers, and only
   * the call stack can tell them apart.
   *
   * Otherwise: a step's own result events belong to that step body, an
   * attribute write names its writer explicitly in the event, and everything
   * else — the step and hook and wait *creations*, the run lifecycle — is the
   * orchestrator committing at a suspension point.
   */
  function writerOfEvent(event: {
    eventType: string;
    runId?: string;
    correlationId?: string;
    eventData?: unknown;
  }): WriterId {
    if (isExternal()) return 'external';

    const data = event.eventData as
      | {
          stepName?: string;
          writer?: { type?: string; stepId?: string };
        }
      | undefined;

    switch (event.eventType) {
      case 'step_completed':
      case 'step_failed':
      case 'step_retrying': {
        const name =
          (data?.stepName && shortStepName(data.stepName)) ||
          stepNameOf(event.runId, event.correlationId);
        return name ? `step:${name}` : 'step:?';
      }
      case 'attr_set': {
        // The only event that states its writer outright.
        if (data?.writer?.type !== 'step') return 'orchestrator';
        const name = stepNameOf(event.runId, data.writer.stepId);
        return name ? `step:${name}` : 'step:?';
      }
      default:
        return 'orchestrator';
    }
  }

  /** Which writer is making a world call. */
  function writerOfCall(
    call: WorldCallName,
    runId: string | undefined,
    request: CallContext['request']
  ): WriterId {
    if (isExternal()) return 'external';
    if (call !== 'events.create' || !request) return 'orchestrator';
    return writerOfEvent({ ...request, runId });
  }

  const watches: { watch: Watch; matches: number }[] = [];
  const watchErrors: string[] = [];
  let resolveApi: (() => ScenarioApi) | undefined;

  function matches(watch: Watch, ctx: CallContext): boolean {
    const { match } = watch;

    // An unspecified phase means `after`, never "both". Matching both would
    // fire every watch twice — and, worse, fire a `nth: 1` watch at `before`,
    // where the effect it is keyed on has not happened yet and `ctx.event` is
    // absent. `before` is the case you opt into.
    if ((match.phase ?? 'after') !== ctx.phase) return false;

    if (match.writer !== undefined) {
      const ok =
        typeof match.writer === 'function'
          ? match.writer(ctx.writer)
          : match.writer === ctx.writer;
      if (!ok) return false;
    }

    const eventTypes = match.eventType
      ? Array.isArray(match.eventType)
        ? match.eventType
        : [match.eventType]
      : undefined;

    if (eventTypes) {
      // `eventType` implies the create call, so a scenario never has to spell
      // out `call: 'events.create'` alongside it.
      if (ctx.call !== 'events.create') return false;
      const type = ctx.event?.eventType ?? ctx.request?.eventType;
      if (!type || !eventTypes.includes(type)) return false;
    } else if (match.call) {
      const calls = Array.isArray(match.call) ? match.call : [match.call];
      if (!calls.includes(ctx.call)) return false;
    }

    if (match.runId && ctx.runId !== match.runId) return false;

    if (match.correlationId) {
      const correlationId =
        ctx.event?.correlationId ?? ctx.request?.correlationId;
      if (correlationId !== match.correlationId) return false;
    }

    if (match.stepName) {
      const data = (ctx.event ?? ctx.request) as
        | { eventData?: { stepName?: string } }
        | undefined;
      const stepName = data?.eventData?.stepName;
      // Accept both the machine name (`step//./workflows/x//reserve`) and the
      // short function name a scenario author would actually type.
      if (
        !stepName ||
        (stepName !== match.stepName &&
          !stepName.endsWith(`//${match.stepName}`))
      ) {
        return false;
      }
    }

    if (match.token) {
      const data = (ctx.event ?? ctx.request) as
        | { eventData?: { token?: string } }
        | undefined;
      if (data?.eventData?.token !== match.token) return false;
    }

    if (
      match.failed !== undefined &&
      match.failed !== (ctx.error !== undefined)
    ) {
      return false;
    }

    if (match.where) {
      // A predicate that throws must not become a world-call failure — see the
      // note on watch actions below. Treat it as "did not match" and report.
      try {
        if (!match.where(ctx, snapshot)) return false;
      } catch (err) {
        watchErrors.push(
          `where(...) for "${watch.options.label ?? 'watch'}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return false;
      }
    }

    return true;
  }

  async function fireWatches(ctx: CallContext): Promise<void> {
    // Calls the scenario itself makes are not call points: they would otherwise
    // trip the very watches they were made from inside of.
    if (isExternal()) return;

    // Iterate a copy: an action may dispose its own watch, or arm a new one.
    for (const entry of [...watches]) {
      if (!watches.includes(entry)) continue;
      if (!matches(entry.watch, ctx)) continue;
      entry.matches++;
      const opts = entry.watch.options;
      if (!opts.every && entry.matches !== (opts.nth ?? 1)) continue;

      pushTrace({
        kind: 'hold',
        label: opts.label ?? 'watch',
        inside: `${ctx.call}:${ctx.phase}`,
        writer: ctx.writer,
      });

      // The action is NOT run inside the external context, and that is
      // deliberate. A hold's action does not return until the scenario releases
      // it, so raising the depth for the duration would mean: for as long as one
      // writer is held, every *other* writer's call stops being a call point and
      // every event it commits is attributed to the scenario. Holding one step
      // body would make its sibling both invisible and unsteerable — the exact
      // interleaving the writer vocabulary exists to state. Scenario-originated
      // writes get their attribution from `asExternal` instead, which follows
      // the call chain rather than the wall clock.
      try {
        if (!resolveApi) {
          throw new Error(
            'A watch fired before the scenario API was installed'
          );
        }
        await entry.watch.action(ctx, resolveApi());
      } catch (err) {
        // A throwing watch must not become a world-call failure. Propagating it
        // would make `events.create` reject and send the runtime down its
        // error-recovery path, which would then be blamed on the runtime
        // rather than on the scenario that actually broke.
        const message = err instanceof Error ? err.message : String(err);
        watchErrors.push(
          `watch "${opts.label ?? 'watch'}" threw inside ${ctx.call}:${ctx.phase}: ${message}`
        );
        pushTrace({
          kind: 'warn',
          message: `watch "${opts.label ?? 'watch'}" failed: ${message}`,
        });
      }
    }
  }

  /** Best-effort extraction of the run a call concerns, for cue matching. */
  function runIdOf(
    call: WorldCallName,
    args: readonly unknown[]
  ): string | undefined {
    switch (call) {
      case 'events.create':
      case 'events.get':
      case 'steps.get':
      case 'runs.get':
      case 'streams.write':
      case 'streams.writeMulti':
      case 'streams.close':
      case 'streams.get':
      case 'streams.getChunks':
      case 'streams.getInfo':
      case 'streams.list':
        return typeof args[0] === 'string' ? args[0] : undefined;
      case 'events.list':
      case 'steps.list':
      case 'hooks.list':
        return (args[0] as { runId?: string } | undefined)?.runId;
      case 'queue':
        return (args[1] as { runId?: string } | undefined)?.runId;
      default:
        return undefined;
    }
  }

  /** Remember a call point, so a later `runTo` can tell "already passed". */
  function record(ctx: CallContext): void {
    if (history.length >= MAX_HISTORY) return;
    const data = (ctx.event ?? ctx.request) as
      | { eventData?: { stepName?: string; token?: string } }
      | undefined;
    const stepName = data?.eventData?.stepName;
    history.push({
      ordinal: history.length,
      seq: ctx.seq,
      writer: ctx.writer,
      call: ctx.call,
      phase: ctx.phase,
      depth: isExternal() ? 1 : 0,
      failed: ctx.error !== undefined,
      ...(ctx.event?.eventType || ctx.request?.eventType
        ? { eventType: ctx.event?.eventType ?? ctx.request?.eventType }
        : {}),
      ...(stepName ? { stepName: shortStepName(stepName) } : {}),
      ...(data?.eventData?.token ? { token: data.eventData.token } : {}),
      ...((ctx.event?.correlationId ?? ctx.request?.correlationId)
        ? {
            correlationId:
              ctx.event?.correlationId ?? ctx.request?.correlationId,
          }
        : {}),
    });
  }

  /**
   * Which events the log the *runtime* is holding contains, keyed by run.
   *
   * This reconstructs the array the client has in memory, which is the whole
   * input to the fence. The runtime does not state it: `@workflow/core`
   * describes its snapshot as a slot count and the sim mints ULIDs, so the
   * facade derives the pair the fence needs — the newest loaded position, and
   * how many events sit at or below it. Since the watermark *is* the maximum of
   * those times, the count is the size of the array. "I loaded N events, the
   * newest at T" is what lets the world spot a hole *behind* T, which no
   * comparison against T alone can see.
   *
   * Keyed by run *within one delivery*, not by writer: the orchestrator and the
   * inline step bodies of one delivery are sim-level writers, but they are one
   * process sharing one loaded log, and that log is what the count describes.
   * Two writers that are genuinely separate processes get separate sets: the
   * out-of-band writer, excluded by the same `isExternal()` rule that keeps it
   * from being a call point, and a concurrent delivery of the same run, which
   * is the shape every replay-race scenario is built on. A map that outlived
   * the delivery would hand a cold-starting replay the previous delivery's
   * view, and the fence would reject it for a log it never claimed to hold.
   *
   * **A read is what starts a set.** Until a writer lists the log it holds
   * nothing, and no write of its own changes that: the client's own snapshot
   * comes from `eventLog`, which is empty until the runtime loads it, and a
   * runtime writing `run_started` before loading anything sends no snapshot at
   * all. Crediting it with that write would hand the fence a position the
   * client never claimed, and a *lower* one than the log holds, so a later
   * concurrent write would be rejected as stale on the strength of a claim
   * nobody made.
   *
   * Once a set exists, everything the caller's own writes append counts, side
   * effects included (a `step_started` claim also appends the `step_created`
   * ahead of it). They have to count: the caller's watermark is taken over a
   * log that includes what it just appended, so counting less would leave the
   * count below the watermark it is paired with and reject current writes.
   *
   * A scan that starts without a cursor replaces the set rather than adding to
   * it — that is the runtime re-reading the log from the beginning, and its
   * earlier view should not linger.
   */
  const deliveryCtx = new AsyncLocalStorage<Map<string, Set<string>>>();
  const loadedEvents = (): Map<string, Set<string>> | undefined =>
    deliveryCtx.getStore();

  function noteLoadedEvents(
    runId: string,
    args: readonly unknown[],
    result: unknown
  ): void {
    const perRun = loadedEvents();
    if (!perRun) return;
    const page = (result as { data?: { eventId?: string }[] } | undefined)
      ?.data;
    if (!page) return;
    const cursor = (args[0] as { pagination?: { cursor?: string } } | undefined)
      ?.pagination?.cursor;
    const set: Set<string> = cursor
      ? (perRun.get(runId) ?? new Set())
      : new Set();
    for (const event of page) if (event.eventId) set.add(event.eventId);
    perRun.set(runId, set);
  }

  /**
   * The snapshot a replay-context write was decided against, or `undefined`
   * when this writer has read nothing for the run and so has no position to
   * name. A writer with an empty log is indistinguishable from an out-of-band
   * one, and the fence treats it that way: there is nothing to compare.
   */
  function loadedSnapshot(
    runId: string | undefined
  ): LoadedSnapshot | undefined {
    if (!runId) return undefined;
    const set = loadedEvents()?.get(runId);
    if (!set || set.size === 0) return undefined;
    let maxSlot = 0;
    for (const eventId of set) {
      const slot = requireEventSlot(eventId);
      if (slot > maxSlot) maxSlot = slot;
    }
    return { maxSlot, count: set.size };
  }

  /** Wrap one world method so it becomes a call point. */
  function intercept<F extends AsyncFn>(call: WorldCallName, fn: F): F {
    return (async (...args: Parameters<F>) => {
      const runId = runIdOf(call, args);
      const request =
        call === 'events.create'
          ? (args[1] as CallContext['request'])
          : undefined;
      const writer = writerOfCall(call, runId, request);

      const base: CallContext = {
        seq: callSeq++,
        call,
        phase: 'before',
        writer,
        args,
        atMs: clock.now(),
        runId,
        ...(request ? { request } : {}),
        ...(call === 'queue' ? { message: args[1] as QueuePayload } : {}),
      };

      record(base);
      await fireWatches(base);

      // The handler boundary. workflow-server mints the event id here
      // (`EventId.make()`, before the storage write is attempted) because
      // DynamoDB does not generate ids and that id *is* the log's sort key. So a
      // write acquires its position and its visibility at two different moments.
      // A scenario holds that gap open with `sim.beginHookDelivery`, which takes
      // the position on one side and lets the write land on the other.
      let callArgs = args;
      let entered = base;
      if (call === 'events.create') {
        // A reserved position wins: it belongs to a write whose handler was
        // entered earlier and is only now reaching storage.
        //
        // No boundary mint for a `run_created` that names no run
        // (`events.create(null, …)`, which the Storage contract allows and the
        // store supports by generating the id). There is no run to allocate
        // against yet: minting under the null key would hand out slots from a
        // bucket shared by every such call, and the generated run's own
        // allocator would then start at 1 and collide. The store mints after it
        // resolves the id instead. The runtime never takes this path, so this
        // is about the failure being impossible rather than merely unobserved.
        const minted =
          reservedPosition ??
          (runId === undefined ? undefined : store.mintEvent(runId));
        reservedPosition = undefined;
        const params = (args[2] ?? {}) as Record<string, unknown>;
        callArgs = [
          args[0],
          args[1],
          {
            ...params,
            ...(minted ? { minted } : {}),
            // The snapshot the fence reads. Reconstructed rather than taken
            // off the wire, because the wire carries only the writer's highest
            // slot and the count guard also wants how many events it loaded at
            // or below it. What the facade tracks is the same array the client
            // is holding (see `loadedEvents`), so the pair it derives is the
            // pair the client would have sent.
            //
            // Attached whenever the fence is armed, not just for the count
            // half: `SimCreateParams.snapshot` is also what marks a write as
            // replay-origin, and an out-of-band write must stay unmarked so it
            // can advance the store's external-write marker.
            ...(options.preconditionGuard && !isExternal()
              ? { snapshot: loadedSnapshot(runId) }
              : {}),
          },
        ] as unknown as Parameters<F>;
        entered = { ...base, args: callArgs };
      }

      // For a create by a writer that has already loaded the log, what that log
      // held going in — so the caller can be credited with everything its own
      // write appended, not just the event the call handed back. A
      // `step_started` claim also appends the `step_created` ahead of it, and a
      // client that did not count both would look like it was holding a hole it
      // had itself just made. A writer that has loaded nothing is left alone;
      // see `loadedEvents`.
      const before =
        call === 'events.create' &&
        runId &&
        !isExternal() &&
        loadedEvents()?.has(runId)
          ? new Set(store.allEvents(runId).map((e) => e.eventId))
          : undefined;

      let result: unknown;
      let error: unknown;
      let threw = false;
      try {
        result = await fn(...callArgs);
      } catch (err) {
        error = err;
        threw = true;
      }

      if (!threw && runId && !isExternal()) {
        if (call === 'events.list') {
          noteLoadedEvents(runId, args, result);
        } else if (before) {
          const set = loadedEvents()?.get(runId);
          if (set) {
            for (const event of store.allEvents(runId)) {
              if (!before.has(event.eventId)) set.add(event.eventId);
            }
          }
        }
      }

      const after: CallContext = {
        ...entered,
        phase: 'after',
        atMs: clock.now(),
        ...(threw ? { error } : {}),
        ...(call === 'events.create' && !threw
          ? { event: (result as { event?: CallContext['event'] })?.event }
          : {}),
      };

      if (threw) {
        // Recorded unconditionally. A rejected write is how a run self-corrects
        // under the optimistic-concurrency fence, so it belongs in the trace by
        // default rather than only when a scenario thought to look for it.
        const rejection: RejectedCall = {
          seq: base.seq,
          call,
          writer: base.writer,
          errorName: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
          ...(request?.eventType ? { eventType: request.eventType } : {}),
        };
        rejected.push(rejection);
        pushTrace({
          kind: 'warn',
          message:
            `world rejected ${call}` +
            `${rejection.eventType ? ` ${rejection.eventType}` : ''}` +
            ` from ${base.writer}: ${rejection.errorName}: ${rejection.message}`,
        });
      }

      record(after);
      await fireWatches(after);

      if (threw) throw error;
      return result;
    }) as F;
  }

  /** Wrap a namespace of world methods, keyed by their call-point name. */
  function interceptAll<T extends Record<string, unknown>>(
    target: T,
    names: { [K in keyof T]?: WorldCallName }
  ): T {
    const out: Record<string, unknown> = {};
    for (const [key, call] of Object.entries(names) as [
      string,
      WorldCallName,
    ][]) {
      const fn = target[key];
      if (typeof fn !== 'function') continue;
      out[key] = intercept(call, (fn as AsyncFn).bind(target));
    }
    return out as T;
  }

  const world: SimWorld = {
    specVersion: SPEC_VERSION_CURRENT,
    // Whether the fence is armed is a store option, not a capability: the
    // runtime assumes every World may reject a stale write, so a scenario can
    // only change what the store does about one, never what the runtime
    // expects. See `SimStoreOptions.preconditionGuard`.
    capabilities: {},
    getDeploymentId: intercept('getDeploymentId', () =>
      simQueue.getDeploymentId()
    ),
    queue: intercept('queue', simQueue.queue),
    createQueueHandler: simQueue.createQueueHandler,
    createRunId: () => ids.ulid(),

    runs: interceptAll(store.runs, {
      get: 'runs.get',
      list: 'runs.list',
    }),
    steps: interceptAll(store.steps, {
      get: 'steps.get',
      list: 'steps.list',
    }),
    events: interceptAll(store.events, {
      create: 'events.create',
      get: 'events.get',
      list: 'events.list',
      listByCorrelationId: 'events.listByCorrelationId',
    }),
    hooks: interceptAll(store.hooks, {
      get: 'hooks.get',
      getByToken: 'hooks.getByToken',
      list: 'hooks.list',
    }),
    streams: interceptAll(streamer.streams, {
      write: 'streams.write',
      writeMulti: 'streams.writeMulti',
      close: 'streams.close',
      get: 'streams.get',
      list: 'streams.list',
      getChunks: 'streams.getChunks',
      getInfo: 'streams.getInfo',
    }),

    clock,
    ids,
    store,
    simQueue,
    streamer,
    snapshot,
    trace,

    // Each delivery is a separate process, and the log it holds is its own.
    // Opening the scope around the handler is what makes `loadedEvents`
    // describe one replay rather than every replay this run has ever had.
    registerHandler: (prefix, handler) =>
      simQueue.registerHandler(prefix as never, (req) =>
        deliveryCtx.run(new Map(), () => handler(req))
      ),
    addWatch(watch) {
      const entry = { watch, matches: 0 };
      watches.push(entry);
      return () => {
        const at = watches.indexOf(entry);
        if (at !== -1) watches.splice(at, 1);
      };
    },
    watchErrors: () => [...watchErrors],
    setScenarioApi(resolve) {
      resolveApi = resolve;
    },
    async asExternal(fn) {
      return externalCtx.run(true, fn);
    },
    reservePosition: (runId) => store.mintEvent(runId),
    async withReservedPosition(position, fn) {
      reservedPosition = position;
      try {
        return await fn();
      } finally {
        reservedPosition = undefined;
      }
    },
    pushTrace,
    callCount: () => callSeq,
    callHistory: () => history,
    rejections: () => rejected,
  };

  return world;
}
