import { InBandSupersededError } from '@workflow/errors';
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
import { eventIdToSlot } from '@workflow/world';

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

function isDefiniteRefusal(error: unknown): boolean {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
  return typeof status === 'number' && status >= 400 && status < 500;
}

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
 * A World without the fence returns no snapshot. The writer then still marks
 * writes `inBand: true` but sends no expected count.
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
  private stoppedBy: unknown;
  private stopped = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly world: Pick<World, 'events'>,
    private readonly runId: string
  ) {}

  /** Take the snapshot of a full load. Later full loads replace it. */
  adoptSnapshot(snapshot: EventLogSnapshot | undefined): void {
    if (this.stopped) return;
    this.expected = snapshot?.seqInBand;
    this.loadedSlot = snapshot?.seq;
    if (snapshot) this.knownMaxSlot = Math.max(this.knownMaxSlot, snapshot.seq);
  }

  /** Whether a refusal or an unknown allocation stopped this writer. */
  get isStopped(): boolean {
    return this.stopped;
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

  /** Throws when the writer has stopped; call before starting an inline body. */
  assertActive(): void {
    if (this.stopped) {
      throw new OrchestratorSupersededError(this.stoppedBy);
    }
  }

  create<T extends CreateEventRequest>(
    data: T,
    params?: CreateEventParams
  ): Promise<EventResult<T['eventType']>> {
    return this.serialize(async () => {
      this.assertActive();
      try {
        const result = await this.world.events.create(this.runId, data, {
          ...this.positionFallback(params?.eventCount),
          ...params,
          ...this.fenceParams(),
        });
        const inferred = this.allocatedBy([result.event]);
        this.advance(result.allocated ?? inferred);
        return result.event
          ? { ...result, event: withWrittenEventData(result.event, data) }
          : result;
      } catch (error) {
        throw this.stop(error);
      }
    });
  }

  createBatch(
    events: BatchEventRequest[],
    params?: Omit<CreateEventBatchParams, 'inBand' | 'expectedSeqInBand'>
  ): Promise<EventBatchResult> {
    const createBatch = this.world.events.createBatch;
    if (!createBatch) {
      return Promise.reject(
        new Error('InBandWriter.createBatch: the World has no createBatch')
      );
    }
    return this.serialize(async () => {
      this.assertActive();
      try {
        const result = await createBatch.call(
          this.world.events,
          this.runId,
          events,
          {
            ...this.positionFallback(params?.eventCount),
            ...params,
            ...this.fenceParams(),
          }
        );
        // Without a reported count: the block was allocated whole (a
        // per-item failure leaves a hole the World seals, and that position
        // still counts), except items answered with an event at a slot this
        // writer already knew, which allocated nothing.
        const replayed = result.results.filter(
          (item) =>
            item.error === undefined && !this.isNewSlot(item.event.eventId)
        ).length;
        for (const item of result.results) {
          if (item.error === undefined) this.noteSlot(item.event.eventId);
        }
        this.advance(result.allocated ?? events.length - replayed);
        return {
          ...result,
          results: result.results.map((item, index) => {
            const request = events[index]?.event;
            return item.error === undefined && request
              ? { ...item, event: withWrittenEventData(item.event, request) }
              : item;
          }),
        };
      } catch (error) {
        throw this.stop(error);
      }
    });
  }

  private fenceParams(): {
    inBand: true;
    expectedSeqInBand?: number;
  } {
    return this.expected === undefined
      ? { inBand: true }
      : { inBand: true, expectedSeqInBand: this.expected };
  }

  private advance(positions: number): void {
    if (this.expected !== undefined) this.expected += positions;
  }

  /**
   * Positions a single accepted write allocated. The World's response does
   * not state it, so it is inferred: an event at a slot this writer already
   * knew to be allocated is an idempotent replay of an earlier write (for
   * example a deduplicated `hook_received`), which allocated nothing.
   */
  private allocatedBy(events: (Event | undefined)[]): number {
    let allocated = 0;
    for (const event of events) {
      if (!event || this.isNewSlot(event.eventId)) allocated++;
      if (event) this.noteSlot(event.eventId);
    }
    return allocated;
  }

  private isNewSlot(eventId: string): boolean {
    const slot = eventIdToSlot(eventId);
    return slot === null || slot > this.knownMaxSlot;
  }

  private noteSlot(eventId: string): void {
    const slot = eventIdToSlot(eventId);
    if (slot !== null && slot > this.knownMaxSlot) this.knownMaxSlot = slot;
  }

  /**
   * An in-band write names the position it was decided from. A caller that
   * names none gets the last full load's `snapshot.seq`: an understatement,
   * which only widens the World's skipped-slot report.
   */
  private positionFallback(
    eventCount: number | undefined
  ): Pick<CreateEventParams, 'eventCount'> {
    if (eventCount !== undefined || this.loadedSlot === undefined) return {};
    return { eventCount: this.loadedSlot };
  }

  private stop(error: unknown): unknown {
    // A definite refusal (a 4xx other than the fence) allocated nothing on
    // a fenced World, so the count stands and the caller may handle it. If
    // the World did allocate after all, the next in-band write is refused
    // and the delivery reloads, which is safe.
    if (!InBandSupersededError.is(error) && isDefiniteRefusal(error)) {
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

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }
}

/**
 * The committed event with the `eventData` this writer sent filled in where
 * the World left it out.
 *
 * A World may answer a create without echoing the payload it stored (the
 * event comes back without its `input`, `result` or `error`), while the
 * orchestrator folds its own writes into the log it replays from, and replay
 * needs those payloads. Only keys the response omits are taken from the
 * request: when a write converged on an event that already existed, the
 * World's copy is the canonical one.
 */
export function withWrittenEventData<E extends Event>(
  event: E,
  request: CreateEventRequest
): E {
  if (event.eventType !== request.eventType) return event;
  const sent = (request as { eventData?: Record<string, unknown> }).eventData;
  if (!sent) return event;
  const stored = (event as { eventData?: Record<string, unknown> }).eventData;
  return { ...event, eventData: { ...sent, ...(stored ?? {}) } };
}
