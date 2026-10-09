import {
  InBandSupersededError,
  RUN_ERROR_CODES,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  BatchEventRequest,
  CreateEventBatchParams,
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventBatchResult,
  EventLogSnapshot,
  EventResult,
  World,
} from '@workflow/world';
import { eventIdToSlot, IN_BAND_SEQ_AT_RUN_CREATION } from '@workflow/world';
import { MAX_BATCH_EVENTS } from '../constants.js';
import { assertWorldSupportsInBandFence } from '../world-compatibility.js';

/**
 * Thrown by an {@link InBandWriter} once the World has refused one of its
 * writes as superseded, for that write and for every write after it. The
 * orchestrator delivery that sees it stops writing and stops starting inline
 * step bodies, does not acknowledge its message, and asks for the same message
 * again after {@link getFenceRedeliveryDelaySeconds}.
 */
export class OrchestratorSupersededError extends Error {
  constructor(readonly cause: unknown) {
    super(
      'This orchestrator invocation was superseded by another invocation of the same run'
    );
    this.name = 'OrchestratorSupersededError';
  }

  static is(value: unknown): value is OrchestratorSupersededError {
    return (
      value instanceof Error && value.name === 'OrchestratorSupersededError'
    );
  }
}

/**
 * Refusals a World makes before it writes anything, recognized by name as
 * well as by status: a World that keeps step or hook state (world-local,
 * world-postgres) throws these without an HTTP status.
 */
const REFUSAL_ERROR_NAMES = new Set([
  'EntityConflictError',
  'RunExpiredError',
  'HookNotFoundError',
  'TooEarlyError',
  'ThrottleError',
  'WorkflowRunNotFoundError',
  'AttributeValidationError',
]);

function isDefiniteRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string' && REFUSAL_ERROR_NAMES.has(name)) return true;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * The fence snapshot a full log load hands the {@link InBandWriter}.
 *
 * Every page of a single-orchestrator run's log carries one
 * (`EventListResponse.snapshot`). The one case without it is a resilient
 * start: `run_created` never landed, so there is no run and the load is empty.
 * The delivery's first in-band write, `run_started` carrying the creation
 * data, follows the creation the World performs for it, which holds the run's
 * first in-band position, so the count is 1.
 *
 * A non-empty log without a snapshot means the World broke the contract, and
 * this throws a World contract error, which fails the run instead of writing
 * without the fence.
 */
export function requireLoadSnapshot(
  runId: string,
  loaded: { events: readonly unknown[]; snapshot?: EventLogSnapshot }
): EventLogSnapshot {
  if (loaded.snapshot) return loaded.snapshot;
  if (loaded.events.length === 0) return RESILIENT_START_SNAPSHOT;
  throw new WorkflowWorldError(
    `The World returned no in-band fence snapshot (\`snapshot: { seq, seqInBand }\`) ` +
      `with the event log of run "${runId}". Every World must return it on ` +
      'single-orchestrator runs; see `WorldCapabilities.inBandFence`.',
    { code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR }
  );
}

/** {@link requireLoadSnapshot}'s answer for a run that does not exist yet. */
export const RESILIENT_START_SNAPSHOT: EventLogSnapshot = Object.freeze({
  seq: 0,
  seqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
});

/** Default delay before a superseded orchestrator delivery is redelivered. */
export const FENCE_REDELIVERY_DELAY_SECONDS = 5;

/**
 * Delay before a superseded orchestrator delivery is redelivered
 * (`WORKFLOW_FENCE_REDELIVERY_DELAY_SECONDS`, default
 * {@link FENCE_REDELIVERY_DELAY_SECONDS}). Small: the winner holds the run, and
 * the redelivery only needs to come after it.
 */
export function getFenceRedeliveryDelaySeconds(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = Number(env.WORKFLOW_FENCE_REDELIVERY_DELAY_SECONDS);
  return Number.isFinite(raw) && raw >= 0
    ? raw
    : FENCE_REDELIVERY_DELAY_SECONDS;
}

/**
 * Writes the orchestrator's in-band events and keeps its count of in-band
 * positions.
 *
 * - The count starts from the first page's `snapshot.seqInBand` of the
 *   delivery's full log load ({@link adoptSnapshot}), never from counting
 *   events: a count cannot say which positions were in-band.
 * - It advances by the number of positions each accepted write allocated,
 *   as the World reports it (`allocated`). A World that does not report it
 *   is assumed to allocate 1 per create and the whole block per batch,
 *   except for an event answered at a slot this writer already knew: that
 *   is an idempotent replay, which allocated nothing.
 * - Writes are serialized. Two concurrent in-band writes would both carry the
 *   same expected count and the second would be refused, so a fan-out goes
 *   through {@link createBatch} or waits its turn.
 * - Run-ahead writes ({@link createAhead}, {@link createBatchAhead}) that queue
 *   up behind a write in flight coalesce: when their turn comes they go out
 *   together as one batch, in the order they were made, with one fence check,
 *   so a pipeline of speculative steps costs one round trip per turn rather
 *   than one per write. Any other write closes the group, so it never
 *   reorders writes. Each write's result is its slice of the batch, checked
 *   in order; a refusal or a failed check stops the writer for every write
 *   behind it, as it does for a required write. A batch on a spec >= 9 run is
 *   not atomic, so on a World that does not order a batch per entity
 *   (`WorldCapabilities.inBandBatchEntityOrder`) a group never carries two
 *   writes for one entity (a step's creation and its outcome): the later one
 *   waits for the next turn, and a refused creation stops the writer before
 *   its outcome is sent, as it did when each write went alone. A World that
 *   orders it refuses the outcome behind a refused creation itself, so a
 *   group there carries several steps. A group stays within {@link MAX_BATCH_EVENTS}
 *   events.
 * - The first refusal stops the writer for good: every later write throws
 *   {@link OrchestratorSupersededError} without reaching the World. The value
 *   the error carries is never adopted.
 * - A write that fails without a definite answer (a transport error, a 5xx)
 *   may or may not have allocated positions, so the count is no longer
 *   known. The writer stops in the same way and the error propagates, so the
 *   delivery is retried and loads the log afresh. A definite refusal (any
 *   other 4xx) leaves the count as it was.
 * - In-band writes on a spec >= 9 run all go through one writer per delivery.
 *   A write made outside it would move the World's count without this one
 *   knowing, and the next write here would be refused.
 *
 * Every World implements the fence (`WorldCapabilities.inBandFence`), so the
 * writer always sends an expected count. A write before any snapshot was
 * adopted is a runtime bug, and fails without reaching the World.
 */
export class InBandWriter {
  private expected: number | undefined;
  /**
   * Highest slot this writer knows is allocated: the load snapshot's `seq`,
   * raised by the slots of its own accepted writes. Used to tell a write
   * that allocated nothing (an idempotent replay answered with the existing
   * event) from one that allocated, and as the fallback `eventCount`.
   */
  private knownMaxSlot = 0;
  /** `snapshot.seq` of the last full load: an understated position. */
  private loadedSlot: number | undefined;
  /**
   * Every event at or below this slot has reached this writer: through a
   * full load, or the complete skipped-slot report of an accepted write
   * (see {@link sendPosition}).
   */
  private completeThrough = 0;
  private stoppedBy: unknown;
  private stopped = false;
  /**
   * Set by {@link stopDecisions}: the error every write it does not allow
   * fails with, and the test of what it still allows.
   */
  private decisionsStop:
    | {
        error: unknown;
        mayStillWrite: (events: readonly CreateEventRequest[]) => boolean;
      }
    | undefined;
  /**
   * Run-ahead writes waiting for their turn, sent together as one batch when
   * it comes. Closed (unset) once the turn starts or another write queues.
   */
  private openGroup: AheadWrite[] | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  /** Throws for a World that does not declare the fence. */
  constructor(
    private readonly world: Pick<World, 'events' | 'capabilities'>,
    private readonly runId: string
  ) {
    assertWorldSupportsInBandFence(world);
  }

  /**
   * Take the snapshot of a full load (see {@link requireLoadSnapshot}). Later
   * full loads replace it.
   */
  adoptSnapshot(snapshot: EventLogSnapshot): void {
    if (this.stopped) return;
    this.expected = snapshot.seqInBand;
    this.loadedSlot = snapshot.seq;
    this.completeThrough = snapshot.seq;
    this.knownMaxSlot = Math.max(this.knownMaxSlot, snapshot.seq);
  }

  /** Whether a snapshot was adopted, so the writer has a count to send. */
  get hasSnapshot(): boolean {
    return this.expected !== undefined;
  }

  /** Whether a refusal or an unknown allocation stopped this writer. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Stops the writer for every write `mayStillWrite` does not allow, and keeps
   * sending the ones it does, in order. Used when the run's path may have
   * changed under decisions this delivery made ahead of their writes: those
   * decisions must not reach the World, while the outcome of a step whose
   * body already ran is a fact about that body and still can. Every refused
   * write, and {@link assertActive}, throws `error`. A later {@link halt} or
   * failed write still stops the writer for good.
   */
  stopDecisions(
    error: unknown,
    mayStillWrite: (events: readonly CreateEventRequest[]) => boolean
  ): void {
    if (this.stopped || this.decisionsStop) return;
    this.decisionsStop = { error, mayStillWrite };
  }

  /** Throws when the writer may not send these events. */
  private assertMayWrite(events: readonly CreateEventRequest[]): void {
    if (this.stopped) this.assertActive();
    if (this.decisionsStop && !this.decisionsStop.mayStillWrite(events)) {
      throw this.decisionsStop.error;
    }
  }

  /** Whether the stop came from a fence refusal. */
  get isSuperseded(): boolean {
    return this.stopped && InBandSupersededError.is(this.stoppedBy);
  }

  /** Whether the World can take a batch write. */
  get supportsBatch(): boolean {
    return typeof this.world.events.createBatch === 'function';
  }

  /** The current expected count, for diagnostics and tests. */
  get expectedSeqInBand(): number | undefined {
    return this.expected;
  }

  /**
   * Throws when the writer has stopped; call before starting an inline body.
   * See the comment inside for which error.
   */
  assertActive(): void {
    if (!this.stopped) {
      if (this.decisionsStop) throw this.decisionsStop.error;
      return;
    }
    // A fence refusal stops the delivery as superseded. Any other stop was
    // a write whose outcome is unknown (a transport error, a 5xx); every
    // later write fails with that same error, so the delivery is retried
    // the way that error is, and never reported as superseded.
    if (InBandSupersededError.is(this.stoppedBy)) {
      throw new OrchestratorSupersededError(this.stoppedBy);
    }
    throw this.stoppedBy;
  }

  create<T extends CreateEventRequest>(
    data: T,
    params?: CreateEventParams
  ): Promise<EventResult<T['eventType']>> {
    return this.write(data, params, false);
  }

  /**
   * A write every later write of this delivery depends on: turbo mode's
   * backgrounded `run_started`. Writes queue behind it like any other, but
   * any failure stops the writer, a definite refusal included, so nothing
   * this delivery writes afterwards reaches the World, and
   * {@link assertActive} refuses to start further inline bodies. The later
   * writes and {@link assertActive} throw this write's error.
   */
  createRequired<T extends CreateEventRequest>(
    data: T,
    params?: CreateEventParams,
    /**
     * Checks the accepted write before any later write is sent. A throw
     * stops the writer with the thrown error, as a failed write would. Used
     * by run-ahead to confirm that a speculative write landed where the
     * workflow already consumed it.
     */
    verify?: (result: EventResult<T['eventType']>) => void
  ): Promise<EventResult<T['eventType']>> {
    return this.write(data, params, true, verify);
  }

  /**
   * The slot the next write would take if no other writer appends first:
   * one past every position this writer knows is allocated, including the
   * writes still queued in it. Run-ahead places a speculative event there.
   */
  predictNextSlot(): number {
    return this.knownMaxSlot + this.pendingPositions + 1;
  }

  /** A position another writer took, seen in a load, a report or the feed. */
  observeSlot(slot: number): void {
    if (slot > this.knownMaxSlot) this.knownMaxSlot = slot;
  }

  /**
   * Stops the writer for good with `error`, as a failed write would: every
   * later write and {@link assertActive} throw it.
   */
  halt(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stoppedBy = error;
  }

  /** The error that stopped the writer, if it stopped. */
  get stopCause(): unknown {
    return this.stoppedBy;
  }

  /** Resolves once every write queued so far has settled. */
  idle(): Promise<void> {
    return this.tail.then(() => {});
  }

  private write<T extends CreateEventRequest>(
    data: T,
    params: CreateEventParams | undefined,
    required: boolean,
    verify?: (result: EventResult<T['eventType']>) => void
  ): Promise<EventResult<T['eventType']>> {
    return this.serialize(1, () =>
      this.sendSingle(data, params, required, verify)
    );
  }

  private async sendSingle<T extends CreateEventRequest>(
    data: T,
    params: CreateEventParams | undefined,
    required: boolean,
    verify?: (result: EventResult<T['eventType']>) => void
  ): Promise<EventResult<T['eventType']>> {
    {
      this.assertMayWrite([data]);
      const knownAtSend = this.knownMaxSlot;
      let result: EventResult<T['eventType']>;
      try {
        const position = this.sendPosition(params?.eventCount);
        const written = await this.world.events.create(this.runId, data, {
          ...params,
          ...position,
          ...this.fenceParams(),
        });
        this.noteComplete(position, written, [written.event]);
        const inferred = this.allocatedBy([written.event], knownAtSend);
        const allocated = written.allocated ?? inferred;
        this.advance(allocated);
        result = written.event
          ? {
              ...written,
              event: withWrittenEventData(written.event, data, allocated > 0),
            }
          : written;
      } catch (error) {
        throw this.stop(error, required);
      }
      if (verify) {
        try {
          verify(result);
        } catch (error) {
          throw this.stop(error, true);
        }
      }
      return result;
    }
  }

  createBatch(
    events: BatchEventRequest[],
    params?: Omit<CreateEventBatchParams, 'inBand' | 'expectedSeqInBand'>
  ): Promise<EventBatchResult> {
    return this.writeBatch(events, params, false);
  }

  /**
   * {@link createBatch} as a required write (see {@link createRequired}):
   * any failure stops the writer, and `verify` checks the result before any
   * later write is sent.
   */
  createBatchRequired(
    events: BatchEventRequest[],
    params: Omit<CreateEventBatchParams, 'inBand' | 'expectedSeqInBand'>,
    verify: (result: EventBatchResult) => void
  ): Promise<EventBatchResult> {
    return this.writeBatch(events, params, true, verify);
  }

  /**
   * A run-ahead write: a required write (see {@link createRequired}) that may
   * coalesce with the run-ahead writes queued next to it. `verify` checks the
   * accepted write before any later write is sent.
   */
  createAhead(
    data: CreateEventRequest,
    params: CreateEventParams,
    verify: (result: EventResult) => void
  ): Promise<EventResult> {
    if (!this.supportsBatch) return this.createRequired(data, params, verify);
    return this.enqueueAhead({
      kind: 'single',
      events: [
        {
          event: data,
          ...(params.occurredAt !== undefined
            ? { occurredAt: new Date(params.occurredAt) }
            : {}),
          ...(params.computeInstanceId !== undefined
            ? { computeInstanceId: params.computeInstanceId }
            : {}),
        },
      ],
      params,
      verify: verify as (result: EventResult | EventBatchResult) => void,
    }) as Promise<EventResult>;
  }

  /**
   * A run-ahead batch: {@link createBatchRequired} that may coalesce with the
   * run-ahead writes queued next to it.
   */
  createBatchAhead(
    events: BatchEventRequest[],
    params: Omit<CreateEventBatchParams, 'inBand' | 'expectedSeqInBand'>,
    verify: (result: EventBatchResult) => void
  ): Promise<EventBatchResult> {
    if (!this.supportsBatch) {
      return this.createBatchRequired(events, params, verify);
    }
    return this.enqueueAhead({
      kind: 'batch',
      events,
      params,
      verify: verify as (result: EventResult | EventBatchResult) => void,
    }) as Promise<EventBatchResult>;
  }

  private enqueueAhead(
    write: Omit<AheadWrite, 'resolve' | 'reject'>
  ): Promise<EventResult | EventBatchResult> {
    return new Promise((resolve, reject) => {
      const member: AheadWrite = { ...write, resolve, reject };
      this.pendingPositions += member.events.length;
      if (
        this.openGroup &&
        (this.world.capabilities?.inBandBatchEntityOrder === true ||
          !sharesEntity(this.openGroup, member)) &&
        groupSize(this.openGroup) + member.events.length <= MAX_BATCH_EVENTS
      ) {
        this.openGroup.push(member);
        return;
      }
      const group = [member];
      this.serialize(0, () => this.sendGroup(group)).catch(() => {});
      this.openGroup = group;
    });
  }

  /** Sends a group of run-ahead writes as one batch and splits the result. */
  private async sendGroup(all: AheadWrite[]): Promise<void> {
    if (this.openGroup === all) this.openGroup = undefined;
    const total = all.reduce((sum, write) => sum + write.events.length, 0);
    try {
      // Members the writer may no longer send fail; the rest still go out.
      const group: AheadWrite[] = [];
      for (const write of all) {
        try {
          this.assertMayWrite(write.events.map(({ event }) => event));
          group.push(write);
        } catch (error) {
          write.reject(error);
        }
      }
      if (group.length === 0) return;
      const first = group[0]!;
      // A lone write goes out as itself, never as a batch of one.
      if (group.length === 1 && first.kind === 'single') {
        try {
          first.resolve(
            await this.sendSingle(
              first.events[0]!.event,
              first.params as CreateEventParams,
              true,
              first.verify
            )
          );
        } catch (error) {
          first.reject(error);
        }
        return;
      }
      const events = group.flatMap((write) => write.events);
      // A batch resolves all or nothing; a write that asked for any resolved
      // data (a replay's `skip-step-inputs`) gets all of it.
      const resolveData = group.some(
        (write) =>
          write.params.resolveData !== undefined &&
          write.params.resolveData !== 'none'
      )
        ? ('all' as const)
        : undefined;
      const knownAtSend = this.knownMaxSlot;
      const position = this.sendPosition(first.params.eventCount);
      let result: EventBatchResult;
      try {
        result = await this.world.events.createBatch!.call(
          this.world.events,
          this.runId,
          events,
          {
            ...position,
            ...(first.params.requestId !== undefined
              ? { requestId: first.params.requestId }
              : {}),
            ...(resolveData !== undefined ? { resolveData } : {}),
            ...this.fenceParams(),
          }
        );
      } catch (error) {
        const stopped = this.stop(error, true);
        for (const write of group) write.reject(stopped);
        return;
      }
      this.noteComplete(
        position,
        result,
        result.results.map((item) =>
          item.error === undefined ? item.event : undefined
        )
      );
      // Allocation as for any batch (see writeBatch).
      const fresh = result.results.map(
        (item) =>
          item.error === undefined && isNewSlot(item.event.eventId, knownAtSend)
      );
      const replayed = result.results.filter(
        (item, index) => item.error === undefined && !fresh[index]
      ).length;
      for (const item of result.results) {
        if (item.error === undefined) this.noteSlot(item.event.eventId);
      }
      this.advance(result.allocated ?? events.length - replayed);

      let offset = 0;
      let failed: unknown;
      for (const [index, write] of group.entries()) {
        const count = write.events.length;
        const slice = result.results
          .slice(offset, offset + count)
          .map((item, at) => {
            const request = events[offset + at]?.event;
            return item.error === undefined && request
              ? {
                  ...item,
                  event: withWrittenEventData(
                    item.event,
                    request,
                    fresh[offset + at] === true
                  ),
                }
              : item;
          });
        offset += count;
        if (failed !== undefined) {
          write.reject(failed);
          continue;
        }
        // The skipped-slot report covers what lies below the whole block,
        // so it belongs to the group's first write.
        const report =
          index === 0
            ? {
                ...(result.events !== undefined
                  ? { events: result.events }
                  : {}),
                ...(result.reportIncomplete
                  ? { reportIncomplete: true as const }
                  : {}),
              }
            : {};
        try {
          let answer: EventResult | EventBatchResult;
          if (write.kind === 'single') {
            const item = slice[0];
            if (!item || item.error !== undefined) {
              throw new WorkflowWorldError(
                `A run-ahead ${write.events[0]?.event.eventType} was refused` +
                  (item ? ` (${item.status}: ${item.message})` : ''),
                { status: item?.status }
              );
            }
            answer = { event: item.event, ...report } as EventResult;
          } else {
            answer = {
              results: slice,
              ...report,
              allocated: count,
            } as EventBatchResult;
          }
          write.verify(answer);
          write.resolve(answer);
        } catch (error) {
          failed = this.stop(error, true);
          write.reject(failed);
        }
      }
    } finally {
      this.pendingPositions -= total;
    }
  }

  private writeBatch(
    events: BatchEventRequest[],
    params:
      | Omit<CreateEventBatchParams, 'inBand' | 'expectedSeqInBand'>
      | undefined,
    required: boolean,
    verify?: (result: EventBatchResult) => void
  ): Promise<EventBatchResult> {
    const createBatch = this.world.events.createBatch;
    if (!createBatch) {
      return Promise.reject(
        new Error('InBandWriter.createBatch: the World has no createBatch')
      );
    }
    return this.serialize(events.length, async () => {
      this.assertMayWrite(events.map(({ event }) => event));
      const knownAtSend = this.knownMaxSlot;
      const position = this.sendPosition(params?.eventCount);
      try {
        const result = await createBatch.call(
          this.world.events,
          this.runId,
          events,
          {
            ...params,
            ...position,
            ...this.fenceParams(),
          }
        );
        this.noteComplete(
          position,
          result,
          result.results.map((item) =>
            item.error === undefined ? item.event : undefined
          )
        );
        // Without a reported count: the block was allocated whole (a
        // per-item failure leaves a hole the World seals, and that position
        // still counts), except items answered with an event at a slot this
        // writer knew before sending, which allocated nothing.
        const fresh = result.results.map(
          (item) =>
            item.error === undefined &&
            isNewSlot(item.event.eventId, knownAtSend)
        );
        const replayed = result.results.filter(
          (item, index) => item.error === undefined && !fresh[index]
        ).length;
        for (const item of result.results) {
          if (item.error === undefined) this.noteSlot(item.event.eventId);
        }
        this.advance(result.allocated ?? events.length - replayed);
        const answered: EventBatchResult = {
          ...result,
          results: result.results.map((item, index) => {
            const request = events[index]?.event;
            return item.error === undefined && request
              ? {
                  ...item,
                  event: withWrittenEventData(
                    item.event,
                    request,
                    fresh[index] === true
                  ),
                }
              : item;
          }),
        };
        if (verify) {
          try {
            verify(answered);
          } catch (error) {
            throw this.stop(error, true);
          }
        }
        return answered;
      } catch (error) {
        throw this.stop(error, required);
      }
    });
  }

  private fenceParams(): {
    inBand: true;
    expectedSeqInBand: number;
  } {
    if (this.expected === undefined) {
      throw new WorkflowRuntimeError(
        `InBandWriter for run "${this.runId}" wrote before adopting a log snapshot`
      );
    }
    return { inBand: true, expectedSeqInBand: this.expected };
  }

  private advance(positions: number): void {
    if (this.expected !== undefined) this.expected += positions;
  }

  /**
   * Positions a single accepted write allocated. The World's response does
   * not state it, so it is inferred: an event at a slot this writer already
   * knew to be allocated when it sent the write is an idempotent replay of
   * an earlier write (for example a deduplicated `hook_received`), which
   * allocated nothing. Slots learned while the write was in flight do not
   * count: the live feed can deliver the write's own events, and later
   * ones, before its response.
   */
  private allocatedBy(
    events: (Event | undefined)[],
    knownAtSend: number
  ): number {
    let allocated = 0;
    for (const event of events) {
      if (!event || isNewSlot(event.eventId, knownAtSend)) allocated++;
      if (event) this.noteSlot(event.eventId);
    }
    return allocated;
  }

  private noteSlot(eventId: string): void {
    const slot = eventIdToSlot(eventId);
    if (slot !== null && slot > this.knownMaxSlot) this.knownMaxSlot = slot;
  }

  /**
   * The position an in-band write names when it is sent: the one it was
   * decided from (a caller that names none gets the last full load's
   * `snapshot.seq`), raised to {@link completeThrough}. A write queued behind
   * others was decided from a position below theirs, and naming it would
   * have the World report back every event those writes made, which this
   * writer already has from their responses. Naming more than the decision
   * saw is safe because everything up to `completeThrough` has reached this
   * writer: a load, or a response whose report was complete.
   */
  private sendPosition(
    eventCount: number | undefined
  ): Pick<CreateEventParams, 'eventCount'> {
    const decided = eventCount ?? this.loadedSlot;
    if (decided === undefined) return {};
    return { eventCount: Math.max(decided, this.completeThrough) };
  }

  /**
   * Raises {@link completeThrough} past an accepted write whose response
   * reported everything below it: the write named a position, and its
   * skipped-slot report is neither incomplete nor truncated.
   */
  private noteComplete(
    position: Pick<CreateEventParams, 'eventCount'>,
    response: { reportIncomplete?: boolean; hasMore?: boolean },
    events: (Event | undefined)[]
  ): void {
    if (position.eventCount === undefined) return;
    if (response.reportIncomplete || response.hasMore) return;
    for (const event of events) {
      const slot = event ? eventIdToSlot(event.eventId) : null;
      if (slot !== null && slot > this.completeThrough) {
        this.completeThrough = slot;
      }
    }
  }

  private stop(error: unknown, always = false): unknown {
    // A definite refusal (a 4xx other than the fence) allocated nothing on
    // the World, so the count stands and the caller may handle it. If
    // the World did allocate after all, the next in-band write is refused
    // and the delivery reloads, which is safe. A required write stops the
    // writer either way.
    if (
      !always &&
      !InBandSupersededError.is(error) &&
      isDefiniteRefusal(error)
    ) {
      return error;
    }
    if (!this.stopped) {
      this.stopped = true;
      this.stoppedBy = error;
    }
    return InBandSupersededError.is(error)
      ? new OrchestratorSupersededError(error)
      : error;
  }

  /** Positions of the writes queued in this writer and not yet settled. */
  private pendingPositions = 0;

  private serialize<T>(positions: number, fn: () => Promise<T>): Promise<T> {
    // A write queued behind an open group of run-ahead writes closes it: a
    // later run-ahead write must not be sent ahead of this one.
    this.openGroup = undefined;
    this.pendingPositions += positions;
    const settle = () => {
      this.pendingPositions -= positions;
    };
    const guarded = async (): Promise<T> => {
      try {
        return await fn();
      } finally {
        settle();
      }
    };
    const run = this.tail.then(guarded, guarded);
    this.tail = run.catch(() => {});
    return run;
  }
}

/**
 * The committed event, with the payload this writer sent.
 *
 * A World may answer a create without the payload it stored, or with a lazy
 * reference to it instead of the bytes (world-vercel does both), while the
 * orchestrator folds its own writes into the log it replays from, and replay
 * needs the bytes. For a fresh write (it allocated a position) the event is
 * exactly what this writer sent, so the sent `eventData` wins. For a write
 * that converged on an event that already existed, the World's copy is the
 * canonical one, and only keys it left out are taken from the request.
 */
/** How many events a group of run-ahead writes would send. */
function groupSize(group: AheadWrite[]): number {
  return group.reduce((sum, write) => sum + write.events.length, 0);
}

/** Whether `member` writes an entity a write already in `group` writes. */
function sharesEntity(group: AheadWrite[], member: AheadWrite): boolean {
  const ids = new Set<string>();
  for (const write of group) {
    for (const { event } of write.events) {
      if (event.correlationId) ids.add(event.correlationId);
    }
  }
  return member.events.some(
    ({ event }) =>
      event.correlationId !== undefined && ids.has(event.correlationId)
  );
}

/** A run-ahead write waiting in an open group (see {@link InBandWriter}). */
interface AheadWrite {
  kind: 'single' | 'batch';
  events: BatchEventRequest[];
  params: CreateEventParams | Omit<CreateEventBatchParams, 'inBand'>;
  verify: (result: EventResult | EventBatchResult) => void;
  resolve: (result: EventResult | EventBatchResult) => void;
  reject: (error: unknown) => void;
}

function isNewSlot(eventId: string, knownMaxSlot: number): boolean {
  const slot = eventIdToSlot(eventId);
  return slot === null || slot > knownMaxSlot;
}

export function withWrittenEventData<E extends Event>(
  event: E,
  request: CreateEventRequest,
  fresh: boolean
): E {
  if (event.eventType !== request.eventType) return event;
  const sent = (request as { eventData?: Record<string, unknown> }).eventData;
  if (!sent) return event;
  const stored =
    (event as { eventData?: Record<string, unknown> }).eventData ?? {};
  return {
    ...event,
    eventData: fresh ? { ...stored, ...sent } : { ...sent, ...stored },
  };
}
