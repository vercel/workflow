import {
  InBandSupersededError,
  RunExpiredError,
  WorkflowWorldError,
} from '@workflow/errors';
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
 * It implements the in-band writer fence every World must: it counts in-band
 * positions, returns `snapshot` from `list`, refuses a stale in-band write
 * with `InBandSupersededError`, and refuses an in-band write without an
 * expected count with a 400.
 *
 * It implements the optional parts of the single-orchestrator contract so
 * tests can switch them on and off:
 *
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
  /** The params of every `events.list` call. */
  readonly listCalls: Array<Record<string, unknown>> = [];
  /** Replay events served without their step input (`skipStepInputs`). */
  strippedStepInputs = 0;
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
      subscribe?: boolean;
      /** Raw AES-256 key returned for every run, so payloads are encrypted. */
      encryptionKey?: Uint8Array;
      /**
       * Answer creates with a placeholder in place of the payload bytes, as a
       * World that returns payloads as lazy references does. The log keeps
       * the bytes.
       */
      lazyCreatePayloads?: boolean;
      reportIncomplete?: boolean;
      /**
       * Hook tokens another run already holds: a `hook_created` for one of
       * them commits `hook_conflict` instead, as a World with a token index
       * does.
       */
      takenHookTokens?: readonly string[];
      /**
       * Honor `resolveData: 'skip-step-inputs'` on replay pages (list pages
       * and skipped-slot reports): `step_created` and `step_started` are
       * served without `input`. The log and the created event keep it.
       */
      skipStepInputs?: boolean;
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

  /**
   * Seed a run with an existing log, as a fresh process would find it: the
   * events keep their ids, and every position counts as in-band, so the next
   * orchestrator delivery adopts it all from the snapshot.
   */
  seedLog(
    run: Omit<WorkflowRun, 'specVersion'> & { specVersion?: number },
    events: readonly Event[]
  ) {
    this.run = { specVersion: SPEC_VERSION_CURRENT, ...run } as WorkflowRun;
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

  asWorld(): World {
    const self = this;
    const events: World['events'] = {
      async create(_runId: string | null, data: any, params?: any) {
        self.checkRunAcceptsWork(data.eventType);
        self.checkStepEventData(data);
        self.checkFence(params, 1);
        const event = self.append(self.committedHook(data));
        self.creates.push({ event, params });
        const slot = self.seq;
        return {
          event: self.responseEvent(event),
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
              // A refused item's position is sealed, as a World seals it, so
              // a later load reads a `noop` there rather than a hole.
              self.append({ eventType: 'noop' } as Partial<Event>);
              return {
                status: 410,
                error: 'gone',
                message: (error as Error).message,
              };
            }
            const event = self.append(
              self.committedHook(data as Partial<Event>)
            );
            self.creates.push({ event, params: params as CreateEventParams });
            return { status: 200 as const, event: self.responseEvent(event) };
          }),
        };
      },
      async get(_runId: string, eventId: string) {
        const event = self.events.find((e) => e.eventId === eventId);
        if (!event) throw new Error(`no event ${eventId}`);
        return event;
      },
      async list(params): Promise<EventListResponse> {
        self.listCalls.push({ ...(params as object) });
        const cursor = params.pagination?.cursor;
        const desc = params.pagination?.sortOrder === 'desc';
        let data = self.events.filter((e) => !cursor || e.eventId > cursor);
        if (desc) data = [...data].reverse();
        const limit = params.pagination?.limit;
        const page = limit ? data.slice(0, limit) : data;
        return {
          data: self.served(
            page,
            (params as { resolveData?: unknown }).resolveData
          ),
          cursor: page.at(-1)?.eventId ?? cursor ?? null,
          hasMore: page.length < data.length,
          snapshot: { seq: self.seq, seqInBand: self.seqInBand },
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
        return self.options.encryptionKey;
      },
      capabilities: { inBandFence: true },
      async getDeploymentId() {
        return self.run?.deploymentId ?? 'dpl_test';
      },
    } as unknown as World;
  }
}
