import {
  EntityConflictError,
  InBandSupersededError,
  RunExpiredError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type BatchEventRequest,
  type CreateEventParams,
  type CreateEventRequest,
  decideRateLimit,
  decideRateWake,
  type Event,
  type EventListResponse,
  type EventResult,
  IN_BAND_SEQ_AT_RUN_CREATION,
  type ListEventsParams,
  MAX_RATE_WAIT_MS,
  orchestratorRunIdOf,
  type QueueBatchResult,
  RATE_MAX_LATE_WAKES,
  rateLimitIntervalUs,
  rateLimitToleranceUs,
  SPEC_VERSION_RATE_LIMITS,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  singleOrchestratorContinuationPayload,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { vi } from 'vitest';

/**
 * The limits world-vercel puts on one `createBatch` call, the World this fake
 * models: at most 100 events, and at most 768 KiB of frame meta and payloads.
 * They are the World's, held here apart from the runtime's own batch budget
 * (`MAX_IN_BAND_CREATION_BATCH_*` in `runtime/constants.ts`), so a change to
 * that budget, or to how the runtime counts a batch's bytes, cannot raise
 * what this fake accepts along with it.
 */
export const WORLD_EVENT_BATCH_LIMITS = Object.freeze({
  maxEvents: 100,
  maxBytes: 768 * 1024,
});

/**
 * The bytes one batch item takes on the wire, as this fake counts them,
 * independently of the runtime's estimate: its JSON with every binary
 * payload left out, plus each payload's length.
 */
export function eventBatchItemBytes(event: unknown): number {
  let payloadBytes = 0;
  const json = JSON.stringify(event, (_key, value: unknown) => {
    if (ArrayBuffer.isView(value)) {
      payloadBytes += value.byteLength;
      return null;
    }
    return value;
  });
  return Buffer.byteLength(json ?? '') + payloadBytes;
}

/** One `world.queue` call recorded by {@link AppendOnlyWorld}. */
export interface RecordedQueueCall {
  queueName: string;
  message: unknown;
  opts?: Record<string, unknown>;
}

/** A queue message the World holds until a test delivers it. */
export interface HeldMessage {
  message: unknown;
  messageId: string;
  queueName: string;
  deliveryCount: number;
  createdAt: Date;
  opts?: Record<string, unknown>;
  /** Deliveries of this message that ended in a handoff. */
  handoffCount?: number;
  /**
   * Delivered as the given re-run of a coalesced delivery: the next
   * `deliveryCount` by this many, `attempt` unchanged.
   */
  coalescedRerun?: number;
  /** Passed as `meta.invocationStartedAt`. */
  invocationStartedAt?: number;
  /**
   * When the queue's clock makes the message due (epoch ms): its send time
   * plus its delay, or a redelivery's time plus its `timeoutSeconds`. Read by
   * {@link AppendOnlyWorld.runOnClock}.
   */
  dueAtMs?: number;
}

/** One delivery a test made, with what the handler returned. */
export interface RecordedDelivery {
  message: unknown;
  messageId: string;
  deliveryCount: number;
  result: unknown;
}

/** One `events.create` call recorded by {@link AppendOnlyWorld}. */
export interface RecordedCreate {
  event: Event;
  params?: CreateEventParams;
}

/**
 * An in-memory World that keeps no step or wait state: every step and wait
 * event is a plain append, with no exists, terminal, `retryAfter` or
 * `stepName` checks. Run state is checked the way the World contract still
 * asks (writes that start work on a terminal run are refused).
 *
 * It implements the in-band writer fence a World that creates spec 9 runs
 * must: it counts in-band
 * positions, returns `snapshot` from `list`, refuses a stale in-band write
 * with `InBandSupersededError`, and refuses an in-band write without an
 * expected count with a 400. It stores an in-band write at its `occurredAt`,
 * orders a batch per entity, and treats `{ timeoutSeconds: 0 }` as a
 * handoff, as every World does for a single-orchestrator run.
 *
 * It implements the optional parts of the single-orchestrator contract so
 * tests can switch them on and off:
 *
 * - `subscribe`: the live feed.
 * - `reportIncomplete`: answer in-band writes with an incomplete skipped-slot
 *   report (`hasMore: true`).
 * - `noReport`: answer in-band writes with no skipped-slot report at all.
 *
 * Every created event is recorded, so a test can assert what the runtime
 * wrote and with which params.
 */
export class AppendOnlyWorld {
  readonly events: Event[] = [];
  readonly creates: RecordedCreate[] = [];
  readonly queueCalls: RecordedQueueCall[] = [];
  /** `queue` calls in flight, with {@link options.queueDelayMs}. */
  queueInFlight = 0;
  /** The most `queue` calls in flight at once, with `queueDelayMs`. */
  maxQueueInFlight = 0;
  /**
   * `queue` calls still in flight as each delivery ended, with
   * `queueDelayMs`: a delivery acknowledges or hands off only once every
   * message it owes is out.
   */
  readonly queueInFlightAtDeliveryEnd: number[] = [];
  /** Wait timer messages whose `queue` call has returned: out in the queue. */
  waitTimersOut = 0;
  /** Messages enqueued and not yet acknowledged. */
  readonly held: HeldMessage[] = [];
  readonly deliveries: RecordedDelivery[] = [];
  /** The event types of every `createBatch` call, in call order. */
  readonly batches: string[][] = [];
  /**
   * The messages of every `queueBatch` call (with the `queueBatch` option),
   * in call order. Each message is also recorded in {@link queueCalls}.
   */
  readonly queueBatches: RecordedQueueCall[][] = [];
  /**
   * Every in-band write's named position and first slot, in call order: how
   * many positions its skipped-slot report covered.
   */
  readonly reportSpans: { eventCount: number; firstSlot: number }[] = [];
  /** How many `events.create` and `events.createBatch` calls were made. */
  createCalls = 0;
  /** The params of every `events.list` call. */
  readonly listCalls: Array<Record<string, unknown>> = [];
  /** Every `events.listByCorrelationId` call, in order. */
  readonly correlationListCalls: Array<Record<string, unknown>> = [];
  /** Replay events served without their step input (`skipStepInputs`). */
  strippedStepInputs = 0;
  /**
   * The run's event ceiling, reported as `maxEvents` on `run_started`
   * responses and on every `list` page. Unreported when absent. Mutable, so a
   * test can model a run whose log is already past the ceiling.
   */
  maxEvents: number | undefined;
  private handler:
    | ((message: unknown, meta: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  seq = 0;
  seqInBand = 0;
  /** Each rate limit key's next free slot (epoch µs), as `world-local` keeps. */
  readonly rateTats = new Map<string, number>();
  private readonly subscribers = new Set<{
    afterSlot: number;
    onEvent: (event: Event) => void;
  }>();
  /** Delayed live-feed pushes, in commit order (`subscribeDelayMs`). */
  private pushes: Promise<void> = Promise.resolve();
  private run: WorkflowRun | undefined;
  /** The orchestrator delivery in flight, in `coalesce` mode. */
  private activeOrchestrator: { coalesced: number } | undefined;
  /** How many messages were coalesced into a delivery, in `coalesce` mode. */
  coalescedMessages = 0;
  /** Deliveries handed off past `maxCoalescedReruns`, in `coalesce` mode. */
  coalescedHandoffs = 0;
  /** Handoffs continued on a new message (see `rotateHandoff`). */
  rotations = 0;
  /** Messages a test enqueued (see `enqueue`), for their unique ids. */
  private enqueued = 0;
  /** Idempotency keys of the messages being delivered, with their counts. */
  private readonly deliveringKeys = new Map<string, number>();
  /**
   * Idempotency keys of acknowledged messages. A queue keeps a key past the
   * message's acknowledgment (Vercel Queues for `min(retention, 24h)`), so a
   * late send under it is dropped too.
   */
  private readonly acknowledgedKeys = new Set<string>();
  /** When each idempotency key was last sent as a new message (epoch ms). */
  private readonly keySentAtMs = new Map<string, number>();

  constructor(
    readonly options: {
      subscribe?: boolean;
      /**
       * How the live feed's `subscribe` fails, as on a World whose push
       * transport is unavailable: `microtask` accepts the subscription and
       * reports an error through `onError` in a microtask; `throw` throws
       * from `subscribe`. Implies `subscribe`.
       */
      subscribeFailure?: 'microtask' | 'throw';
      /** Raw AES-256 key returned for every run, so payloads are encrypted. */
      encryptionKey?: Uint8Array;
      /**
       * Answer creates with a placeholder in place of the payload bytes, as a
       * World that returns payloads as lazy references does. The log keeps
       * the bytes.
       */
      lazyCreatePayloads?: boolean;
      reportIncomplete?: boolean;
      noReport?: boolean;
      /** Leave `events.createBatch` out, as a World without batch writes. */
      noBatch?: boolean;
      /**
       * Offer `queueBatch`, recorded in {@link AppendOnlyWorld.queueBatches}.
       * Each message is published as a single `queue` call would be. A throw
       * from `failQueueBatch` fails that call whole.
       */
      queueBatch?: boolean;
      /** Called with each `queueBatch` call's messages before it publishes. */
      failQueueBatch?: (
        messages: readonly { message: unknown; opts?: unknown }[]
      ) => void | Promise<void>;
      /**
       * Answer every `events.create` and `events.createBatch` this many
       * milliseconds late, after committing, as a remote World's round trip.
       */
      createDelayMs?: number;
      /**
       * Answer every `queue` call this many milliseconds late, as a remote
       * queue's round trip. {@link AppendOnlyWorld.maxQueueInFlight} records
       * how many overlapped.
       */
      queueDelayMs?: number;
      /**
       * Push each event to the live feed this many milliseconds after it
       * committed (in commit order), as on a World whose push travels apart
       * from a write's answer and can arrive well after it. Without it the
       * push is synchronous with the commit.
       */
      subscribeDelayMs?: number;
      /**
       * Called after an `events.create` or `events.createBatch` committed and
       * before it answers, with the events it committed. A test awaits in it
       * to hold the answer back while the commit is already visible (the live
       * feed has pushed it), as on a remote World whose push outruns the
       * answer.
       */
      afterCommit?: (committed: readonly Event[]) => void | Promise<void>;
      /**
       * Hook tokens another run already holds: a `hook_created` for one of
       * them commits `hook_conflict` instead, as a World with a token index
       * does.
       */
      takenHookTokens?: readonly string[];
      /** The spec version the seeded run is stamped with (default 9). */
      runSpecVersion?: number;
      /**
       * Declare `capabilities.rateEventsInBatch` and decide rate events in a
       * batch as a single write does. Without it a batch carrying one is
       * refused whole, as a World without the capability refuses it.
       */
      rateEventsInBatch?: boolean;
      /**
       * Refuses a rate event in a batch before deciding it, reserving
       * nothing, when this returns a refusal: as the backend answers one it
       * had no time to decide (503 `rate-batch-deferred`), or one too early
       * by its clock (425). `index` is the item's position in the batch.
       */
      refuseBatchedRate?: (
        event: CreateEventRequest,
        index: number
      ) => { status: number; error: string } | undefined;
      /**
       * Honor `resolveData: 'skip-step-inputs'` on replay pages (list pages
       * and skipped-slot reports): `step_created` and `step_started` are
       * served without `input`. The log and the created event keep it.
       */
      skipStepInputs?: boolean;
      /**
       * Record a resilient start's creation on its `run_started` alone, as a
       * spec-9 World may (`isRunCreationEvent`): the `run_started` that
       * creates the run takes the first slot with its creation data, and no
       * `run_created` is written. The creation keeps in-band position 1 and
       * the start takes 2, and the write reports `allocated: 1`.
       */
      creationOnStart?: boolean;
      /**
       * Whether a handoff (`{ timeoutSeconds: 0 }`) of `held` continues on a
       * new message instead, as world-vercel does for a message close to its
       * expiry: the held message is acknowledged, and a new one (fresh id,
       * first delivery) is held in its place, with the payload
       * `singleOrchestratorContinuationPayload` builds from the held one.
       */
      rotateHandoff?: (held: HeldMessage) => boolean;
      /**
       * Called with the delay of every `{ timeoutSeconds }` result, so a
       * test with fake timers can let that time pass before the redelivery.
       */
      advanceClock?: (seconds: number) => void;
      /**
       * Coalesce like a VQS concurrency key: a keyed message (an orchestrator
       * message by `orchestratorRunIdOf`, so not a step message and not an
       * intermediate wait hop) enqueued undelayed while one of the run's
       * orchestrator deliveries runs is not held but counted on that
       * delivery, and a delivery that would acknowledge with messages
       * counted runs its handler again until none are, each re-run with the
       * next `deliveryCount` and the same `attempt`, as world-vercel reports
       * one. A delayed message is held; a test that lets one come due while
       * a delivery runs calls {@link AppendOnlyWorld.comeDue}.
       */
      coalesce?: boolean;
      /**
       * In `coalesce` mode, the most re-runs of one delivery; past them the
       * message is handed off (redelivered, not counted as an attempt), as
       * world-vercel does. Unbounded when absent.
       */
      maxCoalescedReruns?: number;
      /**
       * Called before every `events.create`, before anything is checked or
       * written. A test throws from it to refuse a write, or awaits in it to
       * hold one back.
       */
      beforeCreate?: (
        data: { eventType: string; eventData?: Record<string, unknown> },
        params: CreateEventParams | undefined,
        /** Whether the event is an item of a `createBatch` call. */
        source?: { batch: boolean }
      ) => void | Promise<void>;
      /**
       * Called before every `events.list`, after the call is recorded. A test
       * awaits in it to hold a read back, as a remote World's read that is
       * held in transit.
       */
      beforeList?: (params: ListEventsParams) => void | Promise<void>;
      /**
       * How long the queue deduplicates an idempotency key after the send
       * that made it held a message, in ms of the (possibly faked) system
       * clock, whether that message is still held, being delivered, or was
       * acknowledged. Past it a send under the key is a new message, as on a
       * queue with a finite dedupe window (world-vercel's is 24 hours).
       * Absent: a key is deduplicated for as long as the fake lives.
       */
      keyDedupeWindowMs?: number;
      /** Initial {@link AppendOnlyWorld.maxEvents}. */
      maxEvents?: number;
      /**
       * Report {@link AppendOnlyWorld.maxEvents} on `run_started` responses
       * only, not on `list` pages, as a World that predates the list field.
       */
      maxEventsOnStartOnly?: boolean;
      /**
       * The most events one `list` page without a `limit` returns, as a World
       * that bounds a full-log read and answers `hasMore` past it.
       */
      listPageSize?: number;
    } = {}
  ) {
    this.maxEvents = options.maxEvents;
  }

  /** Seed a run as if `run_created` had been written. */
  seedRun(run: Omit<WorkflowRun, 'specVersion'> & { specVersion?: number }) {
    this.run = {
      specVersion:
        this.options.runSpecVersion ?? SPEC_VERSION_SINGLE_ORCHESTRATOR,
      ...run,
    } as WorkflowRun;
    this.append({
      eventType: 'run_created',
      runId: run.runId,
      eventData: {
        deploymentId: run.deploymentId,
        workflowName: run.workflowName,
        input: run.input,
      },
    } as Partial<Event>);
    this.seqInBand = this.seq;
  }

  /**
   * Seed a run with an existing log, as a fresh process would find it: the
   * events keep their ids, and every position counts as in-band, so the next
   * orchestrator delivery adopts it all from the snapshot.
   */
  seedLog(
    run: Omit<WorkflowRun, 'specVersion'> & { specVersion?: number },
    events: readonly Event[]
  ) {
    this.run = {
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      ...run,
    } as WorkflowRun;
    for (const event of events) {
      this.events.push(structuredClone(event));
      this.applyToRun(event);
    }
    this.events.sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    this.seq = Math.max(
      0,
      ...this.events.map((e) => Number(e.eventId.slice('evnt_'.length)))
    );
    this.seqInBand = this.seq;
  }

  /**
   * A `run_started` for a run this World never saw (`run_created` did not
   * land) creates the run from the creation data it carries, as a World does
   * for resilient start. The creation counts as the run's first in-band
   * position.
   */
  private createRunFromStart(
    runId: string,
    eventData: Record<string, unknown>
  ): boolean {
    this.run = {
      runId,
      workflowName: eventData.workflowName,
      deploymentId: eventData.deploymentId,
      executionContext: eventData.executionContext,
      input: eventData.input,
      status: 'pending',
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as WorkflowRun;
    if (this.options.creationOnStart) {
      // The run_started is appended at the first slot by the caller.
      this.seqInBand = IN_BAND_SEQ_AT_RUN_CREATION;
      return true;
    }
    this.append({
      eventType: 'run_created',
      runId,
      eventData: {
        deploymentId: eventData.deploymentId,
        workflowName: eventData.workflowName,
        input: eventData.input,
      },
    } as Partial<Event>);
    this.seqInBand = this.seq;
    return false;
  }

  /** Append an event as an out-of-band writer would. */
  appendOutOfBand(event: Partial<Event>): Event {
    return this.append(event);
  }

  /**
   * The step-event shape a single-orchestrator World requires (world-vercel
   * refuses it otherwise): every step event names its step, and a start,
   * retry or failure carries the attempt.
   */
  private checkStepEventData(data: {
    eventType: string;
    eventData?: Record<string, unknown>;
  }): void {
    if (!data.eventType.startsWith('step_')) return;
    if (typeof data.eventData?.stepName !== 'string') {
      throw new Error(
        `Event type '${data.eventType}' requires eventData.stepName`
      );
    }
    // World-vercel keys a `step_created` input's payload ref by workflow
    // name, and its batch route reads the name from the event alone.
    if (
      data.eventType === 'step_created' &&
      typeof data.eventData?.workflowName !== 'string'
    ) {
      throw new Error(
        `Event type 'step_created' requires eventData.workflowName`
      );
    }
    if (
      ['step_started', 'step_retrying', 'step_failed'].includes(data.eventType)
    ) {
      const attempt = data.eventData?.attempt;
      if (!Number.isInteger(attempt) || (attempt as number) < 1) {
        throw new Error(
          `Event type '${data.eventType}' requires eventData.attempt (a positive integer)`
        );
      }
    }
    // An inline step's creation is its first `step_started`, carrying the
    // input: world-vercel keys that input's payload ref by workflow name, and
    // only the first attempt may carry it.
    if (
      data.eventType === 'step_started' &&
      data.eventData?.input !== undefined
    ) {
      if (typeof data.eventData.workflowName !== 'string') {
        throw new Error(
          `A step_started carrying its step's input requires eventData.workflowName`
        );
      }
      if (data.eventData.attempt !== 1) {
        throw new Error(
          'Only the first step_started of a step may carry its input'
        );
      }
    }
  }

  private append(
    partial: Partial<Event>,
    slotOverride?: number,
    /** An in-band write's `occurredAt`: its time is the one its writer chose. */
    createdAt?: Date
  ): Event {
    const slot = slotOverride ?? ++this.seq;
    const event = {
      ...partial,
      runId: this.run?.runId ?? partial.runId,
      eventId: slotToEventId(slot),
      createdAt: createdAt ?? new Date(),
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    } as Event;
    this.events.push(event);
    this.events.sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    this.applyToRun(event);
    const push = () => {
      for (const sub of this.subscribers) {
        if (slot > sub.afterSlot) sub.onEvent(event);
      }
    };
    const delayMs = this.options.subscribeDelayMs;
    if (delayMs === undefined) {
      push();
    } else {
      // One chain, so pushes keep commit order whatever their timers do.
      this.pushes = this.pushes.then(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              push();
              resolve();
            }, delayMs)
          )
      );
    }
    return event;
  }

  private applyToRun(event: Event): void {
    if (!this.run) return;
    const status: Record<string, WorkflowRun['status']> = {
      run_started: 'running',
      run_completed: 'completed',
      run_failed: 'failed',
      run_cancelled: 'cancelled',
    };
    const next = status[event.eventType];
    if (!next) return;
    if (['completed', 'failed', 'cancelled'].includes(this.run.status)) return;
    this.run = {
      ...this.run,
      status: next,
      ...(next === 'running' && !this.run.startedAt
        ? { startedAt: event.createdAt }
        : {}),
    } as WorkflowRun;
  }

  private checkFence(params: CreateEventParams | undefined, n: number): void {
    if (params?.inBand !== true) return;
    if (params.expectedSeqInBand === undefined) {
      throw new WorkflowWorldError(
        'An in-band write must carry expectedSeqInBand',
        { status: 400 }
      );
    }
    if (params.expectedSeqInBand !== this.seqInBand) {
      throw new InBandSupersededError('in-band-superseded', {
        seq: this.seq,
        seqInBand: this.seqInBand,
      });
    }
    this.seqInBand += n;
  }

  private checkRunAcceptsWork(eventType: string): void {
    const startsWork = [
      'step_created',
      'step_started',
      'step_retrying',
      'wait_created',
      // A rate limit write reserves a slot of a key every run shares.
      'rate_created',
      'rate_acquired',
    ];
    if (
      this.run &&
      ['completed', 'failed', 'cancelled'].includes(this.run.status) &&
      startsWork.includes(eventType)
    ) {
      throw new RunExpiredError(`run ${this.run.runId} is terminal`);
    }
    // As the World's run stamp does: every event but the run's own lifecycle
    // needs a started run, and a remote World answers a write ahead of
    // `run_started` with a 410.
    if (this.run?.status === 'pending' && !eventType.startsWith('run_')) {
      throw new RunExpiredError(
        `run ${this.run.runId} has status 'pending'; it must be running`
      );
    }
  }

  private report(
    params: CreateEventParams | undefined,
    ownSlot: number
  ): Pick<EventResult, 'events' | 'cursor' | 'hasMore'> {
    if (params?.inBand !== true || params.eventCount === undefined) return {};
    if (this.options.noReport) return {};
    if (this.options.reportIncomplete) {
      return { events: [], cursor: null, hasMore: true };
    }
    const skipped = this.events.filter((event) => {
      const slot = Number(event.eventId.slice('evnt_'.length));
      return slot > (params.eventCount ?? 0) && slot < ownSlot;
    });
    return {
      events: this.served(skipped, params?.resolveData),
      cursor: null,
      hasMore: false,
    };
  }

  /** Replay events as a page with `resolveData` serves them. */
  private served(events: Event[], resolveData: unknown): Event[] {
    if (!this.options.skipStepInputs || resolveData !== 'skip-step-inputs') {
      return events;
    }
    return events.map((event) => {
      const eventData = (event as { eventData?: Record<string, unknown> })
        .eventData;
      if (
        (event.eventType !== 'step_created' &&
          event.eventType !== 'step_started') ||
        !eventData ||
        !('input' in eventData)
      ) {
        return event;
      }
      this.strippedStepInputs++;
      const { input: _input, ...rest } = eventData;
      return { ...event, eventData: rest } as Event;
    });
  }

  /** The event a `hook_created` create commits. */
  private committedHook(data: Partial<Event>): Partial<Event> {
    const token = (data as { eventData?: { token?: string } }).eventData?.token;
    if (
      data.eventType !== 'hook_created' ||
      token === undefined ||
      !this.options.takenHookTokens?.includes(token)
    ) {
      return data;
    }
    return {
      eventType: 'hook_conflict',
      specVersion: data.specVersion,
      correlationId: data.correlationId,
      eventData: { token, conflictingRunId: 'wrun_token_owner' },
    } as Partial<Event>;
  }

  /**
   * The event a rate limit write commits, as a World declaring `rateLimits`
   * decides it (see `world-local`): a `rate_created` reserves its slot and
   * becomes `rate_acquired`, `rate_created` with `acquireAt`, or
   * `rate_failed`; a `rate_acquired` must name its own `rate_created`, once,
   * after its `acquireAt`. `reserve` stores the reservation; the caller runs
   * it only once the write is accepted.
   */
  private committedRate(
    data: Partial<Event>,
    // The World's own count, for a call reserved again after a late wake.
    lateWakes = 0
  ): {
    event: Partial<Event>;
    reserve?: () => void;
  } {
    const eventData = (data as { eventData?: Record<string, unknown> })
      .eventData;
    // As every World that declares `rateLimits` does: no rate event on a run
    // stamped below spec 10.
    if (
      (data.eventType === 'rate_created' ||
        data.eventType === 'rate_acquired') &&
      (this.run?.specVersion ?? 0) < SPEC_VERSION_RATE_LIMITS
    ) {
      throw new WorkflowWorldError(
        `${data.eventType} can only be written to a run stamped at spec version ${SPEC_VERSION_RATE_LIMITS} or later`,
        { status: 400 }
      );
    }
    if (data.eventType === 'rate_created' && eventData) {
      // One request per call, as world-local refuses a second (a call
      // reserved again is decided here from its rate_acquired instead).
      if (
        lateWakes === 0 &&
        this.events.some((event) => event.correlationId === data.correlationId)
      ) {
        throw new EntityConflictError(
          `Rate limit call "${data.correlationId}" already exists`
        );
      }
      const call = {
        key: eventData.key as string,
        limit: eventData.limit as number,
        periodMs: eventData.periodMs as number,
        ...(typeof eventData.burst === 'number' &&
          eventData.burst > 1 && { burst: eventData.burst }),
      };
      const expiresAt = new Date(
        Math.min(
          new Date(eventData.expiresAt as Date).getTime(),
          Date.now() + MAX_RATE_WAIT_MS
        )
      );
      const nowUs = Date.now() * 1000;
      const decision = decideRateLimit({
        tatUs: this.rateTats.get(call.key),
        intervalUs: rateLimitIntervalUs(call),
        toleranceUs: rateLimitToleranceUs(call),
        nowUs,
        deadlineUs: expiresAt.getTime() * 1000,
      });
      const request = {
        ...call,
        expiresAt,
        ...(lateWakes > 0 && { lateWakes }),
      };
      if (decision.status === 'deadline_exceeded') {
        const failed = {
          ...data,
          eventType: 'rate_failed',
          eventData: {
            ...request,
            reason: 'max_wait',
            acquireAt: new Date(Math.ceil(decision.wouldAcquireAtUs / 1000)),
          },
        } as Partial<Event>;
        return { event: failed };
      }
      const reserve = () => this.rateTats.set(call.key, decision.tatUs);
      if (decision.acquireAtUs <= nowUs) {
        const acquired = {
          ...data,
          eventType: 'rate_acquired',
          eventData: {
            ...request,
            acquireAt: new Date(Math.floor(decision.acquireAtUs / 1000)),
          },
        } as Partial<Event>;
        return { event: acquired, reserve };
      }
      const waiting = {
        ...data,
        eventData: {
          ...request,
          acquireAt: new Date(Math.ceil(decision.acquireAtUs / 1000)),
          creatorMessageId: eventData.creatorMessageId,
        },
      } as Partial<Event>;
      return { event: waiting, reserve };
    }
    if (data.eventType === 'rate_acquired' && eventData) {
      const createdId = slotToEventId(eventData.createdSlot as number);
      const created = this.events.find((event) => event.eventId === createdId);
      if (
        created?.eventType !== 'rate_created' ||
        created.correlationId !== data.correlationId
      ) {
        throw new EntityConflictError(
          `Slot ${eventData.createdSlot} does not hold the rate_created of ${data.correlationId}`
        );
      }
      // Settled: acquired, failed, or reserved again past its grace window.
      if (
        this.events.some(
          (event) =>
            event.correlationId === data.correlationId &&
            event.eventId > createdId
        )
      ) {
        throw new EntityConflictError(
          `${data.correlationId} was already acquired`
        );
      }
      const acquireAt = new Date(created.eventData.acquireAt as Date);
      if (acquireAt.getTime() > Date.now()) {
        throw new TooEarlyError(`${data.correlationId} is not due`, {
          retryAfter: Math.ceil((acquireAt.getTime() - Date.now()) / 1000),
        });
      }
      const lateWakes =
        (created.eventData.lateWakes as number | undefined) ?? 0;
      const wake = decideRateWake({
        acquireAt,
        nowMs: Date.now(),
        periodMs: created.eventData.periodMs as number,
        lateWakes,
        expiresAt: new Date(created.eventData.expiresAt as Date),
      });
      if (wake === 'reserve_again') {
        // Woken past its grace window: reserved again from the recorded call.
        return this.committedRate(
          {
            ...data,
            eventType: 'rate_created',
            eventData: created.eventData,
          } as Partial<Event>,
          Math.min(lateWakes + 1, RATE_MAX_LATE_WAKES)
        );
      }
      const {
        creatorMessageId: _creator,
        lateWakes: _lateWakes,
        ...recorded
      } = created.eventData;
      if (wake === 'fail') {
        // Late past its largest grace and past its deadline: it fails.
        const failed = {
          ...data,
          eventType: 'rate_failed',
          eventData: {
            ...recorded,
            ...(lateWakes > 0 && { lateWakes }),
            reason: 'max_wait',
            acquireAt,
          },
        } as Partial<Event>;
        return { event: failed };
      }
      const acquired = {
        ...data,
        eventData: { ...recorded, createdSlot: eventData.createdSlot },
      } as Partial<Event>;
      return { event: acquired };
    }
    return { event: data };
  }

  /**
   * Deliver one held message to the registered queue handler, the way a
   * queue would: a `{ timeoutSeconds }` result keeps the same message (same
   * id, next delivery count); anything else acknowledges it; a rejection
   * keeps it too.
   */
  async deliver(held: HeldMessage): Promise<unknown> {
    if (!this.handler) throw new Error('no queue handler registered');
    const index = this.held.indexOf(held);
    if (index !== -1) this.held.splice(index, 1);
    const orchestrator =
      this.options.coalesce === true &&
      orchestratorRunIdOf(held.message) !== undefined &&
      this.activeOrchestrator === undefined;
    if (!orchestrator) return this.deliverOnce(held);
    const active = { coalesced: 0 };
    this.activeOrchestrator = active;
    try {
      let covered = 0;
      let current = held;
      for (let rerun = 1; ; rerun++) {
        const result = await this.deliverOnce(current);
        if (result !== undefined || active.coalesced === covered) {
          return result;
        }
        if (rerun > (this.options.maxCoalescedReruns ?? Infinity)) {
          // Out of re-runs: hand the message off.
          this.coalescedHandoffs++;
          this.held.push({
            ...held,
            deliveryCount: held.deliveryCount + 1,
            handoffCount: (held.handoffCount ?? 0) + 1,
          });
          return result;
        }
        covered = active.coalesced;
        current = { ...held, coalescedRerun: rerun };
      }
    } finally {
      this.activeOrchestrator = undefined;
    }
  }

  /**
   * Lets a held (delayed) message come due now, as the queue's clock would.
   * In `coalesce` mode, a keyed one (see `coalesce`) that comes due while an
   * orchestrator delivery of the run runs is coalesced into it: no longer
   * held, never delivered, and counted on that delivery, which runs again.
   * Returns whether it was coalesced; otherwise it stays held for the test
   * to deliver.
   */
  comeDue(held: HeldMessage): boolean {
    if (
      !this.activeOrchestrator ||
      orchestratorRunIdOf(held.message) === undefined
    ) {
      return false;
    }
    const index = this.held.indexOf(held);
    if (index === -1) return false;
    this.held.splice(index, 1);
    // The queue keeps the key of a message it coalesced, as of one it
    // delivered: the message is consumed.
    const key = held.opts?.idempotencyKey as string | undefined;
    if (key !== undefined) this.acknowledgedKeys.add(key);
    this.activeOrchestrator.coalesced++;
    this.coalescedMessages++;
    return true;
  }

  private async deliverOnce(held: HeldMessage): Promise<unknown> {
    if (!this.handler) throw new Error('no queue handler registered');
    const key = held.opts?.idempotencyKey as string | undefined;
    if (key !== undefined) {
      this.deliveringKeys.set(key, (this.deliveringKeys.get(key) ?? 0) + 1);
    }
    try {
      const result = await this.deliverOnceKeyed(held);
      const acknowledged = !(
        typeof result === 'object' &&
        result !== null &&
        'timeoutSeconds' in result
      );
      if (key !== undefined && acknowledged) this.acknowledgedKeys.add(key);
      return result;
    } finally {
      this.queueInFlightAtDeliveryEnd.push(this.queueInFlight);
      if (key !== undefined) {
        const left = (this.deliveringKeys.get(key) ?? 1) - 1;
        if (left > 0) this.deliveringKeys.set(key, left);
        else this.deliveringKeys.delete(key);
      }
    }
  }

  private async deliverOnceKeyed(held: HeldMessage): Promise<unknown> {
    if (!this.handler) throw new Error('no queue handler registered');
    let result: unknown;
    try {
      result = await this.handler(held.message, {
        attempt: held.deliveryCount - (held.handoffCount ?? 0),
        deliveryCount: held.deliveryCount + (held.coalescedRerun ?? 0),
        ...(held.invocationStartedAt !== undefined && {
          invocationStartedAt: held.invocationStartedAt,
        }),
        createdAt: held.createdAt,
        messageId: held.messageId,
        queueName: held.queueName,
        requestId: `req_${this.deliveries.length + 1}`,
      });
    } catch (error) {
      this.deliveries.push({
        message: held.message,
        messageId: held.messageId,
        deliveryCount: held.deliveryCount,
        result: error,
      });
      this.held.push({ ...held, deliveryCount: held.deliveryCount + 1 });
      throw error;
    }
    this.deliveries.push({
      message: held.message,
      messageId: held.messageId,
      deliveryCount: held.deliveryCount,
      result,
    });
    if (
      typeof result === 'object' &&
      result !== null &&
      'timeoutSeconds' in result
    ) {
      this.options.advanceClock?.(
        (result as { timeoutSeconds: number }).timeoutSeconds
      );
      const handedOff =
        (result as { timeoutSeconds: number }).timeoutSeconds === 0;
      if (handedOff && this.options.rotateHandoff?.(held)) {
        this.rotations++;
        this.held.push({
          // What world-vercel sends: the continuation fields only, never the
          // start message's `runInput`.
          message:
            singleOrchestratorContinuationPayload(held.message) ?? held.message,
          messageId: `msg_rotated_${this.rotations}_of_${held.messageId}`,
          queueName: held.queueName,
          deliveryCount: 1,
          createdAt: new Date(),
        });
        return result;
      }
      const {
        coalescedRerun: _rerun,
        invocationStartedAt: _startedAt,
        ...next
      } = held;
      this.held.push({
        ...next,
        dueAtMs:
          Date.now() +
          Math.max(0, (result as { timeoutSeconds: number }).timeoutSeconds) *
            1000,
        deliveryCount: held.deliveryCount + 1,
        ...(handedOff && { handoffCount: (held.handoffCount ?? 0) + 1 }),
      });
    }
    return result;
  }

  /** Enqueue a message as `start()` or a test would. */
  enqueue(queueName: string, message: unknown): HeldMessage {
    const held: HeldMessage = {
      message,
      messageId: `msg_${++this.enqueued}_ext`,
      queueName,
      deliveryCount: 1,
      createdAt: new Date(),
    };
    this.held.push(held);
    return held;
  }

  /**
   * Deliver held messages, oldest first, until none is left or `limit`
   * deliveries were made. Delays are ignored. `prefer` picks which held
   * messages go ahead of the rest (oldest first among them).
   */
  async runUntilIdle(
    limit = 100,
    options: { prefer?: (held: HeldMessage) => boolean } = {}
  ): Promise<void> {
    const { prefer } = options;
    for (let i = 0; i < limit; i++) {
      const next = (prefer && this.held.find(prefer)) || this.held[0];
      if (!next) return;
      await this.deliver(next);
    }
    throw new Error(
      `still ${this.held.length} message(s) after ${limit} deliveries`
    );
  }

  /**
   * Deliver held messages in the order the queue's clock makes them due,
   * moving the (faked) system clock to each one's due time
   * (`HeldMessage.dueAtMs`), until none is left or `limit` deliveries were
   * made. Among messages due at the same time, `prefer` picks which go first
   * (oldest first otherwise): an orchestrator wake ahead of a step message
   * gives each step outcome its own orchestrator delivery. `deliverAs`
   * changes how a message is delivered (as a coalesced re-run, say). Needs a
   * faked `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`).
   */
  async runOnClock(
    options: {
      limit?: number;
      prefer?: (held: HeldMessage) => boolean;
      deliverAs?: (held: HeldMessage) => HeldMessage;
    } = {}
  ): Promise<void> {
    const { limit = 10_000, prefer, deliverAs } = options;
    const dueAt = (held: HeldMessage) => held.dueAtMs ?? +held.createdAt;
    for (let i = 0; i < limit; i++) {
      if (this.held.length === 0) return;
      const earliest = Math.min(...this.held.map(dueAt));
      const due = this.held.filter((held) => dueAt(held) === earliest);
      const next = (prefer && due.find(prefer)) || due[0]!;
      if (earliest > Date.now()) vi.setSystemTime(earliest);
      if (deliverAs) {
        this.held.splice(this.held.indexOf(next), 1);
        await this.deliver(deliverAs(next));
      } else {
        await this.deliver(next);
      }
    }
    throw new Error(
      `still ${this.held.length} message(s) after ${limit} deliveries`
    );
  }

  /** The created event as a create response carries it. */
  private responseEvent(event: Event): Event {
    if (!this.options.lazyCreatePayloads) return event;
    const eventData = (event as { eventData?: Record<string, unknown> })
      .eventData;
    if (!eventData) return event;
    const lazy: Record<string, unknown> = { ...eventData };
    for (const field of ['input', 'result', 'error', 'payload']) {
      if (field in lazy) lazy[field] = { lazyRef: `${event.eventId}:${field}` };
    }
    return { ...event, eventData: lazy } as Event;
  }

  /** Commits a batch write; see `createBatch` in {@link asWorld}. */
  private commitBatch(
    batch: BatchEventRequest[],
    params: unknown,
    firstSlot: number
  ) {
    const occurredAt = (index: number) => {
      const at = batch[index]?.occurredAt;
      return (params as CreateEventParams | undefined)?.inBand === true && at
        ? new Date(at)
        : undefined;
    };
    const refusedEntities = new Set<string>();
    // An in-band batch's barrier, as the backend keeps it: once a
    // `rate_acquired` is refused, every later item is refused unput.
    let refusedOutcome = false;
    const inBand = (params as CreateEventParams | undefined)?.inBand === true;
    const refuseOutcome = <R>(eventType: string, result: R): R => {
      if (inBand && eventType === 'rate_acquired') refusedOutcome = true;
      return result;
    };
    return {
      ...this.report(params as CreateEventParams, firstSlot),
      results: batch.map(({ event: data }, index) => {
        const entity = (data as { correlationId?: string }).correlationId;
        if (refusedOutcome) {
          this.append({ eventType: 'noop' } as Partial<Event>);
          return {
            status: 409,
            error: 'batch-earlier-position-failed',
            message: 'An earlier outcome in this batch was refused',
          };
        }
        if (entity !== undefined && refusedEntities.has(entity)) {
          this.append({ eventType: 'noop' } as Partial<Event>);
          return {
            status: 409,
            error: 'batch-earlier-item-failed',
            message: `An earlier event for '${entity}' in this batch was refused`,
          };
        }
        try {
          this.checkRunAcceptsWork(data.eventType);
          this.checkStepEventData(data as never);
        } catch (error) {
          // A refused item's position is sealed, as a World seals it, so
          // a later load reads a `noop` there rather than a hole.
          this.append({ eventType: 'noop' } as Partial<Event>);
          if (entity !== undefined) refusedEntities.add(entity);
          return {
            status: 410,
            error: 'gone',
            message: (error as Error).message,
          };
        }
        let committed = this.committedHook(data as Partial<Event>);
        if (
          data.eventType === 'rate_created' ||
          data.eventType === 'rate_acquired'
        ) {
          const refusal = this.options.refuseBatchedRate?.(data, index);
          if (refusal) {
            this.append({ eventType: 'noop' } as Partial<Event>);
            return refuseOutcome(data.eventType, {
              ...refusal,
              message: 'refused before it was decided',
            });
          }
          try {
            const rate = this.committedRate(data as Partial<Event>);
            rate.reserve?.();
            committed = rate.event;
          } catch (error) {
            // Refused as the single write would be, its position sealed.
            this.append({ eventType: 'noop' } as Partial<Event>);
            const status = EntityConflictError.is(error)
              ? 409
              : TooEarlyError.is(error)
                ? 425
                : ((error as { status?: number }).status ?? 400);
            return refuseOutcome(data.eventType, {
              status,
              error: (error as Error).name,
              message: (error as Error).message,
            });
          }
        }
        const event = this.append(committed, undefined, occurredAt(index));
        this.creates.push({ event, params: params as CreateEventParams });
        return { status: 200 as const, event: this.responseEvent(event) };
      }),
    };
  }

  asWorld(): World {
    const self = this;
    const events: World['events'] = {
      async create(runId: string | null, data: any, params?: any) {
        self.createCalls++;
        await self.options.beforeCreate?.(data, params);
        let createdOnStart = false;
        if (
          !self.run &&
          runId &&
          data.eventType === 'run_started' &&
          data.eventData?.input !== undefined
        ) {
          createdOnStart = self.createRunFromStart(runId, data.eventData);
        }
        self.checkRunAcceptsWork(data.eventType);
        self.checkStepEventData(data);
        const rate = self.committedRate(self.committedHook(data));
        self.checkFence(params, 1);
        // Only a write the fence accepted reserves its slot.
        rate.reserve?.();
        const event = self.append(
          rate.event,
          undefined,
          params?.inBand === true && params.occurredAt
            ? new Date(params.occurredAt)
            : undefined
        );
        self.creates.push({ event, params });
        const slot = self.seq;
        if (params?.inBand && params.eventCount !== undefined) {
          self.reportSpans.push({
            eventCount: params.eventCount,
            firstSlot: slot,
          });
        }
        if (self.options.createDelayMs) {
          await new Promise((r) => setTimeout(r, self.options.createDelayMs));
        }
        await self.options.afterCommit?.([event]);
        return {
          event: self.responseEvent(event),
          run: self.run,
          ...(data.eventType === 'run_started' && self.maxEvents !== undefined
            ? { maxEvents: self.maxEvents }
            : {}),
          ...self.report(params, slot),
          // A start written at the first slot as the creation sits at a
          // position the writer may already count as the creation's: its
          // allocation is stated, as every World writing that shape does.
          ...(createdOnStart ? { allocated: 1 } : {}),
        } as EventResult;
      },
      async createBatch(_runId: string, batch: BatchEventRequest[], params) {
        self.createCalls++;
        self.batches.push(batch.map((item) => item.event.eventType));
        // The same per-event hook a single create runs, so a test that slows
        // one event type slows it however the runtime sends it.
        for (const item of batch) {
          await self.options.beforeCreate?.(
            item.event,
            {
              ...params,
              ...(item.occurredAt ? { occurredAt: item.occurredAt } : {}),
            },
            { batch: true }
          );
        }
        // A World refuses an oversized batch whole, by event count and by
        // bytes (see WORLD_EVENT_BATCH_LIMITS). A lone event is not refused
        // for its size: world-vercel stores a large payload out of line.
        // Every other payload byte is counted, which is stricter than
        // world-vercel, whose byte limit covers only inline-bound payloads.
        if (batch.length > WORLD_EVENT_BATCH_LIMITS.maxEvents) {
          throw new WorkflowWorldError(
            `An event batch may carry at most ${WORLD_EVENT_BATCH_LIMITS.maxEvents} events`,
            { status: 400 }
          );
        }
        const batchBytes = batch.reduce(
          (sum, item) => sum + eventBatchItemBytes(item.event),
          0
        );
        if (
          batch.length > 1 &&
          batchBytes > WORLD_EVENT_BATCH_LIMITS.maxBytes
        ) {
          throw new WorkflowWorldError(
            `An event batch may carry at most ${WORLD_EVENT_BATCH_LIMITS.maxBytes} bytes`,
            { status: 400 }
          );
        }
        if (
          !self.options.rateEventsInBatch &&
          batch.some(({ event }) => event.eventType.startsWith('rate_'))
        ) {
          throw new WorkflowWorldError(
            'A rate event cannot be batched on this World',
            { status: 400 }
          );
        }
        self.checkFence(params as CreateEventParams, batch.length);
        const firstSlot = self.seq + 1;
        if (params?.inBand && params.eventCount !== undefined) {
          self.reportSpans.push({ eventCount: params.eventCount, firstSlot });
        }
        const committed = self.commitBatch(batch, params, firstSlot);
        if (self.options.createDelayMs) {
          await new Promise((r) => setTimeout(r, self.options.createDelayMs));
        }
        await self.options.afterCommit?.(
          committed.results.flatMap((item) =>
            item.error === undefined ? [item.event] : []
          )
        );
        return committed;
      },
      async get(_runId: string, eventId: string) {
        const event = self.events.find((e) => e.eventId === eventId);
        if (!event) throw new Error(`no event ${eventId}`);
        return event;
      },
      async list(params): Promise<EventListResponse> {
        self.listCalls.push({ ...(params as object) });
        await self.options.beforeList?.(params);
        const cursor = params.pagination?.cursor;
        const desc = params.pagination?.sortOrder === 'desc';
        let data = self.events.filter((e) => !cursor || e.eventId > cursor);
        if (desc) data = [...data].reverse();
        const limit = params.pagination?.limit ?? self.options.listPageSize;
        const page = limit ? data.slice(0, limit) : data;
        return {
          data: self.served(
            page,
            (params as { resolveData?: unknown }).resolveData
          ),
          cursor: page.at(-1)?.eventId ?? cursor ?? null,
          hasMore: page.length < data.length,
          snapshot: { seq: self.seq, seqInBand: self.seqInBand },
          ...(self.maxEvents !== undefined && !self.options.maxEventsOnStartOnly
            ? { maxEvents: self.maxEvents }
            : {}),
        };
      },
      async listByCorrelationId(params) {
        self.correlationListCalls.push({ ...(params as object) });
        const matching = self.events.filter(
          (e) =>
            e.correlationId === params.correlationId &&
            (params.runId === undefined || e.runId === params.runId)
        );
        const ordered =
          params.pagination?.sortOrder === 'desc'
            ? [...matching].reverse()
            : matching;
        const limit = params.pagination?.limit;
        const data = limit === undefined ? ordered : ordered.slice(0, limit);
        return {
          data: self.served(data, params.resolveData),
          cursor: null,
          hasMore: data.length < ordered.length,
        };
      },
      ...(self.options.subscribe || self.options.subscribeFailure
        ? {
            subscribe(_runId: string, afterSlot: number, onEvent, opts) {
              if (self.options.subscribeFailure === 'throw') {
                throw new Error('live feed unavailable');
              }
              if (self.options.subscribeFailure === 'microtask') {
                queueMicrotask(() =>
                  opts?.onError?.(new Error('live feed unavailable'))
                );
                return () => {};
              }
              const sub = { afterSlot, onEvent };
              self.subscribers.add(sub);
              return () => {
                self.subscribers.delete(sub);
              };
            },
          }
        : {}),
    } as World['events'];
    if (self.options.noBatch) delete events.createBatch;

    const world = {
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      events,
      runs: {
        async get() {
          if (!self.run) throw new Error('no run');
          return self.run;
        },
      },
      async queue(queueName: string, message: unknown, opts?: object) {
        // Counted once the call returns: the timer is out in the queue.
        const out = <R>(result: R): R => {
          if ((message as { waitContinuation?: unknown }).waitContinuation) {
            self.waitTimersOut++;
          }
          return result;
        };
        if (self.options.queueDelayMs) {
          self.queueInFlight++;
          self.maxQueueInFlight = Math.max(
            self.maxQueueInFlight,
            self.queueInFlight
          );
          try {
            await new Promise((r) => setTimeout(r, self.options.queueDelayMs));
          } finally {
            self.queueInFlight--;
          }
        }
        const options = opts as Record<string, unknown> | undefined;
        self.queueCalls.push({ queueName, message, opts: options });
        const messageId = `msg_${self.queueCalls.length}`;
        if (
          self.activeOrchestrator &&
          orchestratorRunIdOf(message) !== undefined &&
          !(
            options?.delaySeconds !== undefined &&
            (options.delaySeconds as number) > 0
          )
        ) {
          self.activeOrchestrator.coalesced++;
          self.coalescedMessages++;
          return out({ messageId });
        }
        const key = options?.idempotencyKey as string | undefined;
        // Deduplicate like a queue does while the keyed message exists
        // (held, or being delivered) and after it was acknowledged, within
        // the key's dedupe window when there is one.
        const sentAtMs =
          key !== undefined ? self.keySentAtMs.get(key) : undefined;
        const windowOpen =
          self.options.keyDedupeWindowMs === undefined ||
          sentAtMs === undefined ||
          Date.now() - sentAtMs < self.options.keyDedupeWindowMs;
        if (
          key !== undefined &&
          windowOpen &&
          (self.held.some((held) => held.opts?.idempotencyKey === key) ||
            self.deliveringKeys.has(key) ||
            self.acknowledgedKeys.has(key))
        ) {
          return out({ messageId: null });
        }
        if (key !== undefined) self.keySentAtMs.set(key, Date.now());
        const delaySeconds = (options?.delaySeconds as number | undefined) ?? 0;
        self.held.push({
          message,
          messageId,
          queueName,
          deliveryCount: 1,
          createdAt: new Date(),
          dueAtMs: Date.now() + Math.max(0, delaySeconds) * 1000,
          opts: options,
        });
        return out({ messageId });
      },
      createQueueHandler(
        _prefix: string,
        handler: (
          message: unknown,
          meta: Record<string, unknown>
        ) => Promise<unknown>
      ) {
        self.handler = handler;
        return async () => new Response(null, { status: 204 });
      },
      async getEncryptionKeyForRun() {
        return self.options.encryptionKey;
      },
      capabilities: {
        inBandFence: true,
        ...(self.options.rateEventsInBatch ? { rateEventsInBatch: true } : {}),
      },
      async getDeploymentId() {
        return self.run?.deploymentId ?? 'dpl_test';
      },
    } as unknown as World;
    if (self.options.queueBatch) {
      world.queueBatch = async (queueName, messages) => {
        self.queueBatches.push(
          messages.map((entry) => ({
            queueName,
            message: entry.message,
            opts: entry.opts as Record<string, unknown> | undefined,
          }))
        );
        await self.options.failQueueBatch?.(messages);
        const results: QueueBatchResult[] = [];
        for (const entry of messages) {
          const { messageId } = await world.queue(
            queueName,
            entry.message,
            entry.opts
          );
          results.push({ messageId });
        }
        return results;
      };
    }
    return world;
  }
}
