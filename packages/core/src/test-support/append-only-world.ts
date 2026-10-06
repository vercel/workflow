import { InBandSupersededError, RunExpiredError } from '@workflow/errors';
import {
  type BatchEventRequest,
  type CreateEventParams,
  type Event,
  type EventListResponse,
  type EventResult,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';

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
 * It implements the optional parts of the single-orchestrator contract so
 * tests can switch them on and off:
 *
 * - `fence`: count in-band positions, return `snapshot` from `list`, and
 *   refuse a stale in-band write with `InBandSupersededError`.
 * - `subscribe`: the live feed.
 * - `reportIncomplete`: answer in-band writes with an incomplete skipped-slot
 *   report.
 *
 * Every created event is recorded, so a test can assert what the runtime
 * wrote and with which params.
 */
export class AppendOnlyWorld {
  readonly events: Event[] = [];
  readonly creates: RecordedCreate[] = [];
  readonly queueCalls: RecordedQueueCall[] = [];
  /** Messages enqueued and not yet acknowledged. */
  readonly held: HeldMessage[] = [];
  readonly deliveries: RecordedDelivery[] = [];
  private handler:
    | ((message: unknown, meta: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  seq = 0;
  seqInBand = 0;
  private readonly subscribers = new Set<{
    afterSlot: number;
    onEvent: (event: Event) => void;
  }>();
  private run: WorkflowRun | undefined;

  constructor(
    readonly options: {
      fence?: boolean;
      subscribe?: boolean;
      reportIncomplete?: boolean;
      /**
       * Called with the delay of every `{ timeoutSeconds }` result, so a
       * test with fake timers can let that time pass before the redelivery.
       */
      advanceClock?: (seconds: number) => void;
    } = {}
  ) {}

  /** Seed a run as if `run_created` had been written. */
  seedRun(run: Omit<WorkflowRun, 'specVersion'> & { specVersion?: number }) {
    this.run = { specVersion: SPEC_VERSION_CURRENT, ...run } as WorkflowRun;
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

  /** Append an event as an out-of-band writer would. */
  appendOutOfBand(event: Partial<Event>): Event {
    return this.append(event);
  }

  private append(partial: Partial<Event>, slotOverride?: number): Event {
    const slot = slotOverride ?? ++this.seq;
    const event = {
      ...partial,
      runId: this.run?.runId ?? partial.runId,
      eventId: slotToEventId(slot),
      createdAt: new Date(),
      specVersion: SPEC_VERSION_CURRENT,
    } as Event;
    this.events.push(event);
    this.events.sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    this.applyToRun(event);
    for (const sub of this.subscribers) {
      if (slot > sub.afterSlot) sub.onEvent(event);
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
    if (!this.options.fence || params?.inBand !== true) return;
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
    ];
    if (
      this.run &&
      ['completed', 'failed', 'cancelled'].includes(this.run.status) &&
      startsWork.includes(eventType)
    ) {
      throw new RunExpiredError(`run ${this.run.runId} is terminal`);
    }
  }

  private report(
    params: CreateEventParams | undefined,
    ownSlot: number
  ): Pick<EventResult, 'events' | 'cursor' | 'hasMore' | 'reportIncomplete'> {
    if (params?.inBand !== true || params.eventCount === undefined) return {};
    if (this.options.reportIncomplete) return { reportIncomplete: true };
    const skipped = this.events.filter((event) => {
      const slot = Number(event.eventId.slice('evnt_'.length));
      return slot > (params.eventCount ?? 0) && slot < ownSlot;
    });
    return { events: skipped, cursor: null, hasMore: false };
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
    let result: unknown;
    try {
      result = await this.handler(held.message, {
        attempt: held.deliveryCount,
        deliveryCount: held.deliveryCount,
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
      this.held.push({ ...held, deliveryCount: held.deliveryCount + 1 });
    }
    return result;
  }

  /** Enqueue a message as `start()` or a test would. */
  enqueue(queueName: string, message: unknown): HeldMessage {
    const held: HeldMessage = {
      message,
      messageId: `msg_${this.queueCalls.length + this.held.length + 1}_ext`,
      queueName,
      deliveryCount: 1,
      createdAt: new Date(),
    };
    this.held.push(held);
    return held;
  }

  /**
   * Deliver held messages, oldest first, until none is left or `limit`
   * deliveries were made. Delays are ignored.
   */
  async runUntilIdle(limit = 100): Promise<void> {
    for (let i = 0; i < limit; i++) {
      const next = this.held[0];
      if (!next) return;
      await this.deliver(next);
    }
    throw new Error(
      `still ${this.held.length} message(s) after ${limit} deliveries`
    );
  }

  asWorld(): World {
    const self = this;
    const events: World['events'] = {
      async create(_runId: string | null, data: any, params?: any) {
        self.checkRunAcceptsWork(data.eventType);
        self.checkFence(params, 1);
        const event = self.append(data);
        self.creates.push({ event, params });
        const slot = self.seq;
        return {
          event,
          run: self.run,
          ...self.report(params, slot),
        } as EventResult;
      },
      async createBatch(_runId: string, batch: BatchEventRequest[], params) {
        self.checkFence(params as CreateEventParams, batch.length);
        return {
          results: batch.map(({ event: data }) => {
            try {
              self.checkRunAcceptsWork(data.eventType);
            } catch (error) {
              self.seq++;
              return {
                status: 410,
                error: 'gone',
                message: (error as Error).message,
              };
            }
            const event = self.append(data as Partial<Event>);
            self.creates.push({ event, params: params as CreateEventParams });
            return { status: 200 as const, event };
          }),
        };
      },
      async get(_runId: string, eventId: string) {
        const event = self.events.find((e) => e.eventId === eventId);
        if (!event) throw new Error(`no event ${eventId}`);
        return event;
      },
      async list(params): Promise<EventListResponse> {
        const cursor = params.pagination?.cursor;
        const desc = params.pagination?.sortOrder === 'desc';
        let data = self.events.filter((e) => !cursor || e.eventId > cursor);
        if (desc) data = [...data].reverse();
        const limit = params.pagination?.limit;
        const page = limit ? data.slice(0, limit) : data;
        return {
          data: page,
          cursor: page.at(-1)?.eventId ?? cursor ?? null,
          hasMore: page.length < data.length,
          ...(self.options.fence
            ? { snapshot: { seq: self.seq, seqInBand: self.seqInBand } }
            : {}),
        };
      },
      async listByCorrelationId(params) {
        const data = self.events.filter(
          (e) => e.correlationId === params.correlationId
        );
        return { data, cursor: null, hasMore: false };
      },
      ...(self.options.subscribe
        ? {
            subscribe(_runId: string, afterSlot: number, onEvent) {
              const sub = { afterSlot, onEvent };
              self.subscribers.add(sub);
              return () => {
                self.subscribers.delete(sub);
              };
            },
          }
        : {}),
    } as World['events'];

    return {
      specVersion: SPEC_VERSION_CURRENT,
      events,
      runs: {
        async get() {
          if (!self.run) throw new Error('no run');
          return self.run;
        },
      },
      async queue(queueName: string, message: unknown, opts?: object) {
        const options = opts as Record<string, unknown> | undefined;
        self.queueCalls.push({ queueName, message, opts: options });
        const messageId = `msg_${self.queueCalls.length}`;
        const key = options?.idempotencyKey;
        // Deduplicate like a queue does while the keyed message exists.
        if (
          key !== undefined &&
          self.held.some((held) => held.opts?.idempotencyKey === key)
        ) {
          return { messageId: null };
        }
        self.held.push({
          message,
          messageId,
          queueName,
          deliveryCount: 1,
          createdAt: new Date(),
          opts: options,
        });
        return { messageId };
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
        return undefined;
      },
      capabilities: {},
      async getDeploymentId() {
        return self.run?.deploymentId ?? 'dpl_test';
      },
    } as unknown as World;
  }
}
