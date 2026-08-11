import type {
  AnyEventRequest,
  Event,
  EventType,
  Hook,
  QueuePayload,
  Step,
  Wait,
  WorkflowRun,
} from '@workflow/world';

/**
 * Every World method the simulation can be paused on. These names are the
 * scheduling vocabulary: the requirement is that the deterministic sequence be
 * expressed "from whatever the world api is", so a call point is always
 * `(one writer, one of these calls, before|after)`.
 */
export type WorldCallName =
  | 'getDeploymentId'
  | 'queue'
  | 'events.create'
  | 'events.get'
  | 'events.list'
  | 'events.listByCorrelationId'
  | 'runs.get'
  | 'runs.list'
  | 'steps.get'
  | 'steps.list'
  | 'hooks.get'
  | 'hooks.getByToken'
  | 'hooks.list'
  | 'streams.write'
  | 'streams.writeMulti'
  | 'streams.close'
  | 'streams.get'
  | 'streams.getChunks'
  | 'streams.getInfo'
  | 'streams.list';

/**
 * The three points a world call can be caught at.
 *
 * `'before'` and `'after'` bracket the call. `'positioned'` sits between them and
 * exists only for `events.create`, because a write is not one atomic act in a
 * real backend: the handler mints the event id *first* — DynamoDB does not
 * generate ids, and that id is the log's sort key — and only then attempts the
 * storage write. Between the two the event has a position but no visibility.
 *
 * That gap is not a detail. It is the only way a log can later gain an event
 * *behind* a position a reader has already read past, which is the one shape no
 * high-water-mark fence can see. A writer held at `'before'` has decided nothing
 * durable and has no position, so a competing write that lands during the hold
 * sorts *ahead* of it; a writer held at `'positioned'` already owns its slot and
 * a competing write sorts *behind* it. Scenarios need both.
 */
export type CallPhase = 'before' | 'positioned' | 'after';

/**
 * Who made a world call.
 *
 * The simulation's whole subject is concurrent writers to one event log, so
 * every intercepted call is attributed to one. There are three kinds:
 *
 *  - `'orchestrator'` — the workflow function and the machinery around it: the
 *    suspension handler committing `step_created` / `step_started` /
 *    `hook_created` / `wait_created`, the run lifecycle writes, and the event
 *    log *reads* that decide what to do next. One per queue delivery.
 *  - `` `step:${shortName}` `` — one step body. Several are in flight at once
 *    inside a single delivery, each an independently advanceable async context,
 *    each writing its own `step_completed` / `step_failed`. This is the writer
 *    pair that corrupts a log with no out-of-band event involved at all.
 *  - `'external'` — the scenario itself, standing in for everything a real
 *    deployment does out of band: a webhook receiver calling `resumeHook`, an
 *    operator cancelling a run.
 *
 * Two steps sharing a function name share a writer id. That is a real
 * limitation and not worth fixing: a scenario that needs to tell them apart
 * should give them distinct names.
 *
 * The run's very first call — the `runs.create` that `start()` makes before any
 * workflow code exists — is attributed to `'orchestrator'` rather than
 * `'external'`. Formally the client is out of band, but a scenario reads
 * `wf.runToEventCommitted('run_created')` as "let the run get created", and
 * giving that call to a different writer than every other step of the run's own
 * progression would be a wart, not a distinction.
 */
export type WriterId = 'orchestrator' | 'external' | (string & {});

/**
 * What the simulation knows at a call point.
 *
 * `phase: 'after'` means the call's effect is committed to the store but the
 * awaiting caller has not been resumed yet — this is the window the
 * requirement calls out ("the world will add the hook before returning from
 * whatever call commits the step started").
 */
export interface CallContext {
  /** Monotonic index over every intercepted World call in the scenario. */
  seq: number;
  call: WorldCallName;
  phase: CallPhase;
  /** Which writer made this call. */
  writer: WriterId;
  args: readonly unknown[];
  /** Virtual time at which the call was observed. */
  atMs: number;
  /** The run the call concerns, when it can be determined. */
  runId?: string;
  /** For `events.create`: the request as submitted. */
  request?: AnyEventRequest;
  /**
   * For `events.create` from the `positioned` phase onwards: the log position
   * minted for this write. A writer held here already owns where its event will
   * sort, so a scenario can reason about the log's eventual order long before any
   * reader can see the event.
   */
  minted?: { eventId: string; createdAt: Date };
  /** For `events.create` in the `after` phase: the committed event. */
  event?: Event;
  /** For `queue`: the enqueued payload. */
  message?: QueuePayload;
  /** Present in the `after` phase of a call that threw. */
  error?: unknown;
}

/**
 * One point a writer reached, recorded whether or not anything was waiting for
 * it. This history is what makes `runTo` level-triggered: it can answer "has
 * this already happened?" instead of arming a watch that will never fire.
 */
export interface ObservedPoint {
  /**
   * Position in the recorded history, counting from 0.
   *
   * `seq` cannot serve: a call is recorded twice, once per phase, and both
   * records carry the call's `seq`. A writer held at a call's `after` phase has
   * to count that call's `before` phase as behind it, and only a per-record
   * ordinal orders the two.
   */
  ordinal: number;
  seq: number;
  writer: WriterId;
  call: WorldCallName;
  phase: CallPhase;
  eventType?: EventType;
  /** Short step name, when the call carries one. */
  stepName?: string;
  token?: string;
  correlationId?: string;
  /**
   * Nesting depth at which the point occurred. Depth > 0 means it happened
   * inside another call the scenario was already inside, where a hold is not
   * possible — worth distinguishing in an error message.
   */
  depth: number;
}

/** An intercepted world call that threw. */
export interface RejectedCall {
  seq: number;
  call: WorldCallName;
  writer: WriterId;
  eventType?: EventType;
  /** Error constructor name, e.g. `PreconditionFailedError`. */
  errorName: string;
  message: string;
}

/** Read-only view of world state, for matchers and assertions. */
export interface WorldSnapshot {
  nowMs(): number;
  runs(): WorkflowRun[];
  run(runId: string): WorkflowRun | undefined;
  events(runId?: string): Event[];
  steps(runId?: string): Step[];
  hooks(runId?: string): Hook[];
  waits(runId?: string): Wait[];
  /** Queue messages that have been enqueued but not yet delivered. */
  pendingMessages(): PendingMessageView[];
  /**
   * Every intercepted world call that threw, in order.
   *
   * Rejections are the visible mechanism behind a run that self-corrects — a
   * `PreconditionFailedError` from the optimistic-concurrency fence, an
   * `EntityConflictError` from a write against an already-terminal run — so
   * they are recorded unconditionally rather than left to a scenario to
   * instrument.
   */
  rejections(): RejectedCall[];
}

export interface PendingMessageView {
  messageId: string;
  queueName: string;
  runId?: string;
  stepId?: string;
  /** Virtual time at which the message becomes deliverable. */
  readyAtMs: number;
  /** How many times it has already been handed to a handler. */
  deliveries: number;
}

/**
 * Which call point to wait at. Every provided field must match (AND).
 * `where` runs last and can inspect the whole world.
 *
 * This is the low-level vocabulary; scenarios normally express a point through
 * a `Writer` (`wf.runToEventCommitted('step_started', 'reserveInventory')`)
 * rather than assembling a match by hand.
 */
export interface CallMatch {
  call?: WorldCallName | WorldCallName[];
  /**
   * Which side of the call to match. Defaults to `'after'` — the window where
   * the effect is committed but the caller has not been resumed, which is the
   * one worth injecting into. Set `'before'` to act ahead of the write.
   */
  phase?: CallPhase;
  /** Shorthand for `call: 'events.create'` restricted to these event types. */
  eventType?: EventType | EventType[];
  /** Matches `eventData.stepName`, by exact value or by short name suffix. */
  stepName?: string;
  /** Matches the event's `correlationId`. */
  correlationId?: string;
  /** Matches the hook token on `hook_created` / `hook_received` events. */
  token?: string;
  runId?: string;
  /** Restrict to calls made by a particular writer. */
  writer?: WriterId | ((writer: WriterId) => boolean);
  /** Only match calls that threw (`true`) or succeeded (`false`). */
  failed?: boolean;
  where?: (ctx: CallContext, world: WorldSnapshot) => boolean;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/** Extra conditions on a `runTo` point. */
export interface RunToOptions {
  /** Short step name carried by the event, e.g. `'reserveInventory'`. */
  stepName?: string;
  /** Hook token, for `hook_created` / `hook_received`. */
  token?: string;
  correlationId?: string;
  /**
   * Extra condition on world state, evaluated at the candidate point. Use it
   * for "once two steps have completed" — a condition about the world rather
   * than about one event.
   */
  where?: (world: WorldSnapshot) => boolean;
  /** Label for the trace. Defaults to a description of the point. */
  label?: string;
  /** Wall-clock budget for this one wait. Defaults to `limits.maxRunToWallMs`. */
  timeoutMs?: number;
}

/** A writer stopped at a point, waiting to be let go. */
export interface Held {
  /** The writer actually caught — concrete even when the handle was `anyStep()`. */
  writer: WriterId;
  /** What the world was asked to do, and (once committed) what it did. */
  ctx: CallContext;
  /**
   * Let the writer continue. Idempotent. Awaiting it yields the event loop, so
   * once it resolves the released writer has actually made progress.
   */
  release(): Promise<void>;
}

/**
 * One writer, steerable a point at a time.
 *
 * `runTo*` advances this writer to its next matching point and *stops it
 * there*, with every other writer free to keep going. It is level-triggered:
 * if the point has already gone by, it throws with the seq it happened at
 * rather than arming a watch that can never fire, because a missed edge in a
 * world where a held call blocks the scheduler is a hang, not a late wakeup.
 *
 * The corollary is that holds must be **armed before they are needed**. To hold
 * two writers at the same point, start both waits and then await them:
 *
 * ```ts
 * const atFast = fast.runToEventProduced('step_completed'); // armed here
 * const atSlow = slow.runToEventProduced('step_completed'); // and here
 * await atFast;
 * await atSlow;
 * ```
 *
 * Awaiting the first before starting the second yields the event loop, and the
 * other writer may well sail past its point in that gap.
 */
export interface Writer {
  readonly id: WriterId;
  /**
   * Stop once the event has crossed the world boundary — fully formed,
   * attributed to this writer, already in the trace — and before it is assigned
   * a position in the event log.
   *
   * Having no position yet, a write that commits to storage while this one is
   * held sorts *ahead* of it. For the opposite — an event that already owns an
   * earlier slot and has not appeared — use `runToPositionMinted`.
   */
  runToEventProduced(
    eventType: EventType | EventType[],
    options?: string | RunToOptions
  ): Promise<Held>;
  /**
   * Stop *after* the log position is minted and *before* the write commits.
   *
   * The event's id — the log's sort key — is fixed, so it will sort here no matter
   * how long the hold lasts; nothing can read it yet. Holding one writer here
   * while another commits past it is how a scenario opens a hole *behind* the
   * visible tail, with no stale read involved: the reader sees a complete,
   * consistent prefix of the log that is simply missing an event still in flight.
   * That is the shape production has, now that reads are strongly consistent.
   */
  runToPositionMinted(
    eventType: EventType | EventType[],
    options?: string | RunToOptions
  ): Promise<Held>;
  /**
   * Stop just *after* the event is durable and before the writer is resumed.
   * This is the window the requirement is about: "receive the hook after a
   * step_started is committed but before the workflow resumes running".
   */
  runToEventCommitted(
    eventType: EventType | EventType[],
    options?: string | RunToOptions
  ): Promise<Held>;
  /** The same, for a non-`events.create` world call. */
  runToCall(
    call: WorldCallName | WorldCallName[],
    options?: RunToOptions & { phase?: CallPhase }
  ): Promise<Held>;
  /** Let this writer go, if it is held. Idempotent. */
  release(): Promise<void>;
  isHeld(): boolean;
  /** Points this writer has reached, oldest first. */
  history(): readonly ObservedPoint[];
}

/**
 * Handles onto the writers a scenario can steer.
 *
 * A handle is a *name*, not a live object: `sim.writer.step('slow')` can be
 * taken before that step exists and resolves against whichever writer shows up
 * under the name.
 */
export interface WriterHandles {
  /** The workflow function and the runtime machinery around it. */
  orchestrator(): Writer;
  /** One step body, by short function name. */
  step(shortName: string): Writer;
  /** Whichever step body reaches the point first. */
  anyStep(): Writer;
  /** Any writer at all. */
  any(): Writer;
  /** Writer ids seen so far, in first-appearance order. */
  seen(): WriterId[];
}

/**
 * Everything the scenario script can do to the world.
 *
 * These are the only sanctioned sources of external input. Anything a real
 * deployment could do out-of-band — a webhook arriving, an operator
 * cancelling a run, time passing — has an entry here, so the scenario script
 * is a complete description of what happened.
 */
export interface ScenarioApi {
  /** Read-only view of the world at this instant. */
  world: WorldSnapshot;
  /**
   * Deliver a hook payload, exactly as an out-of-band `resumeHook()` would:
   * commit `hook_received` and enqueue the run's flow message.
   *
   * Called while a writer is held, this happens *inside* the call that writer
   * is stopped at, so the event lands in the log before that writer is resumed.
   * That is the entire point of the writer API.
   */
  deliverHook(token: string, payload: unknown): Promise<void>;
  /**
   * Start a hook delivery and stop between its two halves: the log position is
   * taken, the event is not there yet.
   *
   * This is the fault the `in-flight` scenarios are about, and it needs no stale
   * read to express. The receiver's write has entered the handler, so its event
   * id — the log's sort key — is fixed; it has not reached storage, so every
   * reader sees a complete, consistent log that simply does not contain it. When
   * `commit()` runs, the event appears *behind* positions those readers already
   * read past, which is the one shape a high-water mark cannot represent.
   *
   * Unlike a held writer, nothing is blocked in the meantime: the receiver is a
   * separate process from the run's invocation. Holding an *inline* write instead
   * would stall the delivery that made it, and thus the reader too — which is why
   * the out-of-band writer is the one that can do this.
   */
  beginHookDelivery(token: string, payload: unknown): Promise<InFlightWrite>;
  /** Cancel the run under test, as an operator would. */
  cancelRun(reason?: string): Promise<void>;
  /** Jump virtual time forward. */
  advanceTime(ms: number): void;
  /**
   * Hide the next event this scenario commits from the following `reads`
   * event-log reads, modelling one concurrent writer the reader missed.
   *
   * Call it immediately before the write you want hidden. This is the only way
   * a serial simulation can produce "a write derived from an incomplete event
   * load" — the precondition a real deployment reaches through concurrency.
   */
  withholdNextEvent(reads?: number): void;
  /** Record a free-text marker in the scenario trace. */
  note(message: string): void;
  /** Record a named assertion in the trace; a false value fails the scenario. */
  check(name: string, condition: boolean): void;
  /** The run under test. */
  runId: string;
  /**
   * Which log this run is playing against, resolved from the spec and the run
   * option. See `ScenarioSpec.appendOnlyLog`.
   *
   * A check's *name* is a sentence in the trace, and several of them are
   * sentences about where a position came from — "the hook owns a log position
   * but is nowhere in the log" is true of a reserved mint and false of an
   * append-only commit. Read this to phrase the sentence for the world the run
   * is actually in, rather than narrating one world while playing the other.
   *
   * It is not for branching the *tempo*. A scenario whose script takes a
   * different path under the flag is two scenarios wearing one id, and the diff
   * between the two runs stops meaning anything.
   */
  appendOnlyLog: boolean;
}

/** An out-of-band write that owns a log position and has not committed. */
export interface InFlightWrite {
  /** The position it will occupy, whenever it lands. */
  eventId: string;
  /** Let it reach storage. */
  commit(): Promise<void>;
}

/**
 * A world call stopped mid-flight, waiting for the script to let it go. The
 * low-level form of `Held`, without the writer attribution.
 *
 * The vocabulary is borrowed from Python's `blanket`, which does the same
 * thing for `threading` primitives: the call *parks*, the script issues the
 * *permit*, and the resulting order of permits is the scenario's *tempo*.
 */
export interface Parked {
  /** What the world was asked to do, and (in the `after` phase) what it did. */
  ctx: CallContext;
  /** Let the call return. Idempotent. */
  release(): void;
}

/**
 * What a scenario script is handed.
 *
 * The scenario vocabulary is writers: name them, advance them one point at a
 * time, and the interleaving is the script's control flow rather than a race.
 * `park` / `until` / `during` are the primitive underneath — reach for them for
 * a point no writer op names, such as a plain world *read*.
 */
export interface Tempo extends ScenarioApi {
  /** Handles onto the writers this scenario can steer. */
  writer: WriterHandles;
  /**
   * Wait until a world call reaches a matching point, and hold it there.
   *
   * Everything that writer would go on to do is suspended while the call is
   * parked: the caller is blocked inside the world. That is the point —
   * whatever the script does next is guaranteed to land before the call
   * returns.
   *
   * Edge-triggered, unlike `runTo`: if the point has already gone by, this
   * waits for the next one and reports a hang if there is none.
   */
  park(match: CallMatch, label?: string): Promise<Parked>;
  /** Wait for a matching call to happen, without holding it. */
  until(match: CallMatch, label?: string): Promise<CallContext>;
  /** Park a call, run `body` while it is held, then release it. */
  during<T>(
    match: CallMatch,
    body: (parked: Parked) => T | Promise<T>,
    label?: string
  ): Promise<T>;
}

/**
 * A scenario body. Runs concurrently with the delivery loop, starting before
 * the run does so it can hold the very first world call.
 */
export type ScenarioScript = (sim: Tempo) => void | Promise<void>;

/** One line of the scenario trace — either a world event or a simulation action. */
export type TraceEntry =
  | {
      kind: 'event';
      seq: number;
      atMs: number;
      event: Event;
      /** Which writer committed it. */
      writer?: WriterId;
      /** Depth > 0 means the event was committed from inside another call. */
      depth: number;
    }
  | {
      kind: 'hold';
      seq: number;
      atMs: number;
      label: string;
      /** The call point the writer was stopped at. */
      inside: string;
      writer?: WriterId;
      depth: number;
    }
  | {
      kind: 'note' | 'delivery' | 'warn';
      seq: number;
      atMs: number;
      message: string;
      depth: number;
    }
  | {
      kind: 'check';
      seq: number;
      atMs: number;
      name: string;
      ok: boolean;
      depth: number;
    };

export interface InvariantViolation {
  /** Stable identifier, e.g. `step.no-restart-after-terminal`. */
  rule: string;
  message: string;
  runId?: string;
  eventId?: string;
}
