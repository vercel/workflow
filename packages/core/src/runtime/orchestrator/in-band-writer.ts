import { InBandSupersededError } from '@workflow/errors';
import type {
  BatchEventRequest,
  CreateEventBatchParams,
  CreateEventParams,
  CreateEventRequest,
  EventBatchResult,
  EventLogSnapshot,
  EventResult,
  World,
} from '@workflow/world';

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
 * - It advances by the number of positions each accepted write allocated (1
 *   for a single create, the event count for a batch).
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
          ...params,
          ...this.fenceParams(),
        });
        this.advance(1);
        return result;
      } catch (error) {
        throw this.stop(error);
      }
    });
  }

  createBatch(
    events: BatchEventRequest[],
    params?: CreateEventBatchParams & { expectedSeqInBand?: never }
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
            ...params,
            ...this.fenceParams(),
          } as CreateEventBatchParams
        );
        // The block was allocated whole; a per-item failure leaves a hole
        // the World seals, and that position still counts.
        this.advance(events.length);
        return result;
      } catch (error) {
        throw this.stop(error);
      }
    });
  }

  private fenceParams(): Pick<
    CreateEventParams,
    'inBand' | 'expectedSeqInBand'
  > {
    return this.expected === undefined
      ? { inBand: true }
      : { inBand: true, expectedSeqInBand: this.expected };
  }

  private advance(positions: number): void {
    if (this.expected !== undefined) this.expected += positions;
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
