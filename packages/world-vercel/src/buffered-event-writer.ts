import { isDeepStrictEqual } from 'node:util';
import { WorkflowWorldError } from '@workflow/errors';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  type EventResult,
  EventSchema,
  type EventWriteSession,
  getEventDataPayloadField,
  requireEventSlot,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  type Step,
  StepSchema,
  slotToEventId,
} from '@workflow/world';
import { EventsyncDuplicateCommit } from './events-v4.js';

type Write = (
  event: CreateEventRequest,
  params: CreateEventParams,
  onSent?: () => void,
  generation?: number
) => Promise<EventResult>;
/** A (re)connection's catch-up: committed events after `after`, through `head`. */
export type WriterCatchUp = {
  after: number;
  head: number;
  events: Event[];
  expiredAt?: Date;
  generation: number;
};
type Pending = {
  /** Slot this entry occupies. */
  slot: number;
  request: CreateEventRequest;
  params: CreateEventParams;
  /** Deterministic staged outcome; absent for a native (create) write. */
  expected?: EventResult;
  completion: Promise<EventResult>;
  /** Settles when the current attempt settles, however it settles. */
  attempt: Promise<unknown>;
  /** Identifies the current completion; a recovery replaces it. */
  token?: object;
};

/** Time the owner may spend reconnecting before failing its unfinished inputs. */
export const EVENTSYNC_RECONNECT_TIMEOUT_MS = 30_000;

function isTransportFailure(error: unknown): boolean {
  if (error instanceof WorkflowWorldError) return error.code === 'TRANSPORT';
  return (error as { name?: unknown } | null)?.name === 'WsTransportError';
}

function isPermanentTransportFailure(error: unknown): boolean {
  const cause =
    error instanceof WorkflowWorldError
      ? (error as { cause?: unknown }).cause
      : error;
  return (cause as { permanent?: unknown } | null)?.permanent === true;
}

function payloadOf(event: { eventType: string; eventData?: unknown }) {
  const field = getEventDataPayloadField(event.eventType as never);
  return field
    ? (event.eventData as Record<string, unknown> | undefined)?.[field]
    : undefined;
}

/** Identity of a committed event against the write this owner submitted. */
export function matchesSubmitted(
  committed: Event,
  expected: Event,
  request: CreateEventRequest
): boolean {
  return (
    committed.eventId === expected.eventId &&
    committed.eventType === request.eventType &&
    (committed.correlationId ?? undefined) ===
      (request.correlationId ?? undefined) &&
    (committed.resumeId ?? undefined) === (expected.resumeId ?? undefined) &&
    +committed.createdAt === +expected.createdAt &&
    isDeepStrictEqual(
      new Uint8Array((payloadOf(committed) as Uint8Array) ?? []),
      new Uint8Array((payloadOf(request) as Uint8Array) ?? [])
    )
  );
}

/**
 * Owner-private outbox. Standard reads and all materialization remain
 * server-side. When the connection breaks, the writer reconnects from its
 * committed head, confirms outbox entries the log already holds, and resends
 * the rest at the same slots. A log that holds anything else has forked from
 * this owner: the writer fails permanently.
 */
export class BufferedEventWriter implements EventWriteSession {
  private queued?: number;
  private committed?: number;
  private pending: Pending[] = [];
  private confirmed: EventResult[] = [];
  private queuedSteps = new Map<string, Step>();
  private bytes = 0;
  private failure?: unknown;
  private disposed = false;
  private generation?: number;
  private recovery?: Promise<void>;

  constructor(
    private runId: string,
    private write: Write,
    private release: () => Promise<void>,
    private flushThrough: (
      head: number,
      generation?: number
    ) => Promise<void> = async () => {},
    private resync?: () => Promise<WriterCatchUp>,
    private reconnectTimeoutMs = EVENTSYNC_RECONNECT_TIMEOUT_MS
  ) {}

  get heads() {
    return { queued: this.queued, committed: this.committed };
  }

  /** The committed position a reconnect must resume from. */
  get position() {
    return this.committed ?? 0;
  }

  /** Initial catch-up: the whole committed log after the writer's position. */
  async catchUp() {
    if (!this.resync) throw new Error('Event writer has no catch-up stream');
    if (this.queued !== undefined)
      throw new Error('Catch-up must precede the first write');
    const catchUp = await this.resync();
    if (catchUp.after !== 0 || catchUp.events.length !== catchUp.head)
      throw new Error('Invalid initial catch-up');
    this.generation = catchUp.generation;
    this.queued = this.committed = catchUp.head;
    return {
      events: catchUp.events,
      head: catchUp.head,
      ...(catchUp.expiredAt ? { expiredAt: catchUp.expiredAt } : {}),
    };
  }

  private rememberStep(step: Step) {
    if (['completed', 'failed', 'cancelled'].includes(step.status))
      this.queuedSteps.delete(step.stepId);
    else this.queuedSteps.set(step.stepId, step);
  }

  private assertOpen(params?: CreateEventParams) {
    if (this.failure) throw this.failure;
    if (this.disposed) throw new Error('Event writer is disposed');
    const head = params?.eventCount;
    if (!Number.isSafeInteger(head) || head === undefined || head < 0)
      throw new Error('Buffered writer requires a canonical event count');
    this.queued ??= head;
    this.committed ??= head;
    if (head !== this.queued)
      throw new Error('Buffered writer sequence mismatch');
  }

  private fail(error: unknown) {
    this.failure ??= error;
    void this.release().catch(() => {});
    return this.failure;
  }

  /** Send one outbox entry on the current connection. */
  private send(entry: Pending, onSent?: () => void): Promise<EventResult> {
    const attempt = this.write(
      entry.request,
      entry.params,
      onSent,
      this.generation
    );
    entry.attempt = attempt.catch(() => {});
    return attempt;
  }

  /**
   * One attempt's outcome: its own acknowledgement, a duplicate ACK for an
   * identical earlier commit, or — after a transport break — whatever the
   * reconnect established for this entry.
   */
  private settle(
    entry: Pending,
    attempt: Promise<EventResult>
  ): Promise<EventResult> {
    const token = {};
    entry.token = token;
    return attempt.then(
      (result) => this.verify(entry, result),
      async (error: unknown) => {
        if (EventsyncDuplicateCommit.is(error) && entry.expected) {
          if (
            error.eventId !== entry.expected.event!.eventId ||
            +new Date(error.createdAt) !== +entry.expected.event!.createdAt
          )
            throw this.fail(
              new WorkflowWorldError(
                'Buffered canonical acknowledgement mismatch',
                { status: 409 }
              )
            );
          return entry.expected;
        }
        if (!this.resync || !isTransportFailure(error) || this.failure)
          throw this.fail(error);
        for (;;) {
          await this.recover();
          if (this.failure) throw this.failure;
          // The recovery confirmed or resent this entry: follow its outcome.
          if (entry.token !== token) return entry.completion;
        }
      }
    );
  }

  private verify(entry: Pending, result: EventResult): EventResult {
    if (!entry.expected) {
      if (!result.event) throw this.fail(new Error('Missing canonical event'));
      return result;
    }
    const actual = result.event;
    if (
      !actual ||
      actual.eventId !== entry.expected.event!.eventId ||
      actual.runId !== this.runId ||
      actual.eventType !== entry.request.eventType ||
      +actual.createdAt !== +entry.expected.event!.createdAt
    )
      throw this.fail(
        new WorkflowWorldError('Buffered canonical acknowledgement mismatch', {
          status: 409,
        })
      );
    return result;
  }

  /**
   * Reconnect from the committed head, confirm the outbox prefix the log
   * already holds, and resend the rest. Single-flight: every entry of the
   * broken connection waits on the same recovery.
   */
  private recover(): Promise<void> {
    this.recovery ??= this.reconnect().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  private async reconnect() {
    const outbox = this.pending;
    // Every send of the broken connection must settle before resending.
    await Promise.all(outbox.map((entry) => entry.attempt));
    const deadline = Date.now() + this.reconnectTimeoutMs;
    let catchUp: WriterCatchUp | undefined;
    for (let delay = 100; !catchUp; delay = Math.min(delay * 2, 2_000)) {
      if (this.failure) throw this.failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw this.fail(
          new WorkflowWorldError(
            'Eventsync did not reconnect within the owner reconnect timeout',
            { code: 'TRANSPORT' }
          )
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        catchUp = await Promise.race([
          this.resync!(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('reconnect timeout')),
              remaining
            );
          }),
        ]);
      } catch (error) {
        if (isPermanentTransportFailure(error)) throw this.fail(error);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(delay, Math.max(0, remaining)))
        );
      } finally {
        clearTimeout(timer);
      }
    }
    const committed = this.committed ?? 0;
    const forked = (reason: string) =>
      this.fail(
        new WorkflowWorldError(
          `Owner superseded: the committed log diverged from this owner (${reason})`,
          { status: 409, code: 'OWNER_SUPERSEDED' }
        )
      );
    if (catchUp.after !== committed) throw forked('catch-up position');
    // A native write's materialized outcome cannot be rebuilt from the log,
    // so an independent write that may have committed is not recoverable.
    if (catchUp.head > committed && outbox.some((entry) => !entry.expected))
      throw this.fail(
        new WorkflowWorldError(
          'Eventsync lost the connection with an independent write in flight',
          { code: 'TRANSPORT' }
        )
      );
    const queued = Math.max(
      this.queued ?? committed,
      ...outbox.map((entry) => entry.slot)
    );
    if (catchUp.head > queued) throw forked('log is ahead of the outbox');
    const results = new Map<Pending, Promise<EventResult>>();
    for (const [i, event] of catchUp.events.entries()) {
      const slot = committed + 1 + i;
      const entry = outbox.find((candidate) => candidate.slot === slot);
      if (
        !entry?.expected ||
        requireEventSlot(event.eventId) !== slot ||
        !matchesSubmitted(event, entry.expected.event!, entry.request)
      )
        throw forked(`slot ${slot}`);
      results.set(entry, Promise.resolve(entry.expected!));
    }
    this.generation = catchUp.generation;
    for (const entry of outbox) {
      const settled = results.get(entry);
      if (settled) {
        entry.token = {};
        entry.completion = settled;
        continue;
      }
      // Same contents at the same slot, on the new connection, in slot order:
      // each resend reaches the socket before the next (and before any flush).
      let sent!: () => void;
      const transmitted = new Promise<void>((resolve) => {
        sent = resolve;
      });
      const attempt = this.send(entry, sent);
      void attempt.then(sent, sent);
      entry.completion = this.settle(entry, attempt);
      void entry.completion.catch(() => {});
      await transmitted;
    }
  }

  async create(
    event: CreateEventRequest,
    params: CreateEventParams = {}
  ): Promise<EventResult> {
    await this.recovery;
    this.assertOpen(params);
    await this.drain();
    const entry: Pending = {
      slot: params.eventCount! + 1,
      request: event,
      params,
      completion: Promise.resolve(undefined as never),
      attempt: Promise.resolve(),
    };
    this.pending = [entry];
    try {
      entry.completion = this.settle(entry, this.send(entry));
      let result: EventResult;
      // A recovery may replace the completion; wait for the final one.
      for (;;) {
        const current = entry.completion;
        result = await current;
        if (current === entry.completion) break;
      }
      if (!result.event) throw new Error('Missing canonical event');
      this.queued = this.committed = requireEventSlot(result.event.eventId);
      if (result.step) this.rememberStep(result.step);
      return result;
    } catch (error) {
      throw this.fail(error);
    } finally {
      this.pending = [];
    }
  }

  async stage(
    event: CreateEventRequest,
    params: CreateEventParams = {}
  ): Promise<EventResult> {
    await this.recovery;
    this.assertOpen(params);
    const field = getEventDataPayloadField(event.eventType);
    const payload = field
      ? (event.eventData as Record<string, unknown> | undefined)?.[field]
      : undefined;
    const size = payload instanceof Uint8Array ? payload.byteLength : 0;
    const previous = event.correlationId
      ? this.queuedSteps.get(event.correlationId)
      : undefined;
    // Only deterministic, non-expanding transitions may advance the private VM
    // before ACK. Hook registration/conflict and other server-selected outcomes
    // first drain the prefix, then return their native result.
    const eligible =
      (event.specVersion ?? 0) >= SPEC_VERSION_SUPPORTS_SLOT_IDENTITY &&
      size <= 8 * 1024 * 1024 &&
      (event.eventType === 'hook_received' ||
        event.eventType === 'step_created' ||
        (event.eventType === 'step_started' &&
          previous?.status === 'pending') ||
        (event.eventType === 'step_completed' &&
          previous?.status === 'running'));
    if (!eligible) return this.create(event, params);
    if (this.pending.length >= 100 || this.bytes + size > 8 * 1024 * 1024)
      await this.drain();

    const occurredAt = params.occurredAt ?? new Date();
    const request = structuredClone(event);
    const expected: EventResult = {
      event: EventSchema.parse({
        ...request,
        runId: this.runId,
        eventId: slotToEventId(params.eventCount! + 1),
        createdAt: occurredAt,
        occurredAt,
        ...(params.resumeId ? { resumeId: params.resumeId } : {}),
      }),
    };
    if (event.eventType === 'step_created') {
      expected.step = StepSchema.parse({
        ...event.eventData,
        runId: this.runId,
        stepId: event.correlationId,
        status: 'pending',
        attempt: 0,
        createdAt: occurredAt,
        updatedAt: occurredAt,
        specVersion: event.specVersion,
      });
    } else if (event.eventType === 'step_started') {
      expected.step = StepSchema.parse({
        ...previous,
        status: 'running',
        attempt: previous!.attempt + 1,
        startedAt: occurredAt,
        updatedAt: occurredAt,
      });
    } else if (event.eventType === 'step_completed') {
      expected.step = StepSchema.parse({
        ...previous,
        status: 'completed',
        output: event.eventData?.result,
        completedAt: occurredAt,
        updatedAt: occurredAt,
      });
    }
    if (expected.step)
      this.queuedSteps.set(expected.step.stepId, expected.step);
    this.queued = params.eventCount! + 1;
    this.bytes += size;
    let sent!: () => void;
    let sendFailed!: (error: unknown) => void;
    const transmitted = new Promise<void>((resolve, reject) => {
      sent = resolve;
      sendFailed = reject;
    });
    const entry: Pending = {
      slot: params.eventCount! + 1,
      request,
      params: { ...params, occurredAt },
      expected,
      completion: Promise.resolve(expected),
      attempt: Promise.resolve(),
    };
    const attempt = this.send(entry, sent);
    // Receiving any response also proves transmission; a transport failure
    // before transmission is recovered by the writer like any other break.
    void attempt.then(
      () => sent(),
      (error: unknown) =>
        isTransportFailure(error) && this.resync ? sent() : sendFailed(error)
    );
    entry.completion = this.settle(entry, attempt);
    // Observe errors immediately; flush still receives the original rejection.
    void entry.completion.catch(() => {});
    this.pending.push(entry);
    await transmitted;
    if (this.failure) throw this.failure;
    return expected;
  }

  private async drain() {
    if (this.failure) throw this.failure;
    if (!this.pending.length) return;
    try {
      for (;;) {
        try {
          await this.flushThrough(this.queued!, this.generation);
          break;
        } catch (error) {
          if (!this.resync || !isTransportFailure(error) || this.failure)
            throw error;
          await this.recover();
        }
      }
      // Recoveries replace completions; settle on the final ones.
      let results: EventResult[];
      for (;;) {
        const completions = this.pending.map((item) => item.completion);
        results = await Promise.all(completions);
        if (this.recovery) {
          await this.recovery;
          continue;
        }
        if (completions.every((c, i) => c === this.pending[i].completion))
          break;
      }
      if (this.failure) throw this.failure;
      this.confirmed.push(...results);
      this.committed = requireEventSlot(
        results[results.length - 1].event!.eventId
      );
      this.pending = [];
      for (const result of results)
        if (result.step) this.rememberStep(result.step);
      this.bytes = 0;
    } catch (error) {
      throw this.fail(error);
    }
  }

  async flush(): Promise<readonly EventResult[]> {
    await this.drain();
    const results = this.confirmed;
    this.confirmed = [];
    return results;
  }

  async dispose() {
    this.disposed = true;
    await this.release();
  }
}
