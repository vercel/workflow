/**
 * One workflow run = one Durable Object.
 *
 * The object owns the run's event log and runs the workflow:
 *
 * - **Storage.** Every World storage call for the run lands here. Writes go
 *   through `@workflow/world-sim`'s store, the in-memory reference
 *   implementation of the World event contract, and each committed event is
 *   written to the object's SQLite-backed storage before the call returns (the
 *   output gate holds the reply until the write is durable). On a cold start
 *   the store is rebuilt from the persisted log.
 * - **Execution.** A `queue()` call for the run is an execution signal. It is
 *   stored, a backstop alarm is armed, the call returns, and the object runs
 *   core's queue handler in its own isolate. Ordinary (workflow) deliveries
 *   run one at a time, which is what makes the World a single runner per run
 *   (`capabilities.invoke`). Step messages are handed to a separate step
 *   runner invocation and may run in parallel. Delayed messages and wait
 *   deadlines are alarms.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  EntityConflictError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  captureInvocationOutcome,
  isTerminalInvocationError,
  unwrapInvocationOutcome,
} from '@workflow/errors/invocation';
import {
  type CreateEventParams,
  type Event,
  type EventResult,
  getQueueTopicPrefix,
  type InvocationOutcome,
  type InvokeOptions,
  isTerminalWorkflowRunStatus,
  type MessageId,
  type QueueOptions,
  type QueuePayload,
  requireEventSlot,
  SPEC_VERSION_CURRENT,
  type ValidQueueName,
  type WorkflowRun,
} from '@workflow/world';
import { createSimStore, type SimStore } from '@workflow/world-sim/store';
import { monotonicFactory } from 'ulid';
import { call, serve, TOKENS_BINDING } from './rpc.js';
import {
  type DeliveryMeta,
  deliver,
  type FlowRoute,
  getRuntimeConfig,
  runAsLocal,
} from './runtime.js';
import type { ClaimResult } from './token-object.js';
import type { RunApi } from './world.js';

/** A stored `queue()` message: a request to run the workflow, or a step. */
interface Signal {
  messageId: MessageId;
  queueName: ValidQueueName;
  message: QueuePayload;
  kind: 'flow' | 'step';
  /** Epoch ms at which the signal is due. */
  runAt: number;
  /** 1-based attempt number of the next delivery. */
  attempt: number;
  idempotencyKey?: string;
  /** Set when redelivery was abandoned after `MAX_ATTEMPTS` failures. */
  parked?: string;
  /** A delivery of this signal started and has not settled. */
  delivering?: boolean;
}

const EVENT_PREFIX = 'ev:';
const SIGNAL_PREFIX = 'sig:';
const KEY_PREFIX = 'key:';
const INVOKE_PREFIX = 'inv:';
const FENCE_PREFIX = 'fence:';

/** Re-arm interval while deliveries are in flight. */
const BACKSTOP_MS = 10_000;
/** How often an object holding runs pinned to another build re-checks. */
const PINNED_RECHECK_MS = 60 * 60_000;
/** Concurrent step deliveries per run (Workers allow 6 pending subrequests). */
const MAX_STEP_DELIVERIES = 6;
/** Give up redelivering a message that keeps failing. */
const MAX_ATTEMPTS = 100;

const debugEnabled = () => process.env.WORKFLOW_CLOUDFLARE_DEBUG === '1';
function debug(...args: unknown[]) {
  if (debugEnabled()) console.log('[world-cloudflare]', ...args);
}

const eventKey = (slot: number) =>
  `${EVENT_PREFIX}${String(slot).padStart(12, '0')}`;

/** A wake that carries nothing but the run: any later replay subsumes it. */
function isPlainWake(message: QueuePayload): boolean {
  return Object.keys(message).every(
    (key) => key === 'runId' || key === 'traceCarrier' || key === 'requestedAt'
  );
}

/** Serializes async sections: event application must not interleave. */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn);
    this.#tail = next.catch(() => {});
    return next;
  }
}

export class RunObject extends DurableObject<Record<string, unknown>> {
  readonly api: RunApi;

  #runId: string | undefined;
  #store!: SimStore;
  /** The committed log, in slot order. */
  #log: Event[] = [];
  /** Events the store appended during the create in progress. */
  #appended: Event[] = [];
  #lastCreatedAtMs = 0;
  #writes = new Mutex();
  #signals = new Map<string, Signal>();
  #inflight = new Set<string>();
  #flowBusy = false;
  #stepDeliveries = 0;
  #completingWaits = new Set<string>();
  #alarmAt: number | null | undefined;
  #messageIds = monotonicFactory();
  #flowRoute: FlowRoute | undefined;
  /**
   * Signals held back because the run belongs to another build. Not
   * persisted: the next instance (possibly running that build, after a
   * rollback) decides afresh.
   */
  #pinned = new Set<string>();

  /** This instance's own workflow route (see `RuntimeConfig.createFlowRoute`). */
  #flow(): FlowRoute {
    this.#flowRoute ??= getRuntimeConfig().createFlowRoute();
    return this.#flowRoute;
  }

  constructor(ctx: any, env: Record<string, unknown>) {
    super(ctx, env);
    this.api = {
      eventsCreate: (runId, data, params) =>
        this.#eventsCreate(runId, data, params),
      eventsGet: (runId, eventId, params) =>
        this.#withRun(runId, () =>
          this.#store.events.get(runId, eventId, params as never)
        ),
      eventsList: (params) =>
        this.#withRun(params.runId, () => this.#store.events.list(params)),
      eventsListByCorrelationId: (params) =>
        this.#withRun(params.runId, () =>
          this.#store.events.listByCorrelationId(params)
        ),
      runsGet: (runId, params) =>
        this.#withRun(runId, () =>
          this.#store.runs.get(runId, params as never)
        ),
      stepsGet: (runId, stepId, params) =>
        this.#withRun(runId, () =>
          this.#store.steps.get(runId, stepId, params as never)
        ),
      stepsList: (params) =>
        this.#withRun(params.runId, () =>
          this.#store.steps.list(params as never)
        ),
      hooksGet: async (hookId, params) =>
        this.#store.hooks.get(hookId, params as never),
      hooksList: async (params) => this.#store.hooks.list(params),
      enqueue: (queueName, message, opts) =>
        this.#enqueue(queueName, message, opts),
      invoke: (runId, payload, options) =>
        this.#invoke(runId, payload, options),
    };
    ctx.blockConcurrencyWhile(async () => this.#load());
  }

  // ---------------------------------------------------------------------------
  // RPC surface

  /** Generic entry point for the World client (see world.ts `onRun`). */
  async call(method: keyof RunApi, args: unknown[]) {
    return serve(() =>
      (this.api[method] as (...a: unknown[]) => Promise<unknown>)(...args)
    );
  }

  /**
   * Is `hookId` a live hook of this run? Asked by a token object before it
   * hands this hook's token to another claimant. A hook this run has never
   * created is fenced first: its `hook_created` can no longer commit, so a
   * "dead" answer stays true. Deliberately outside the write mutex: the
   * claimer may be this run, waiting on that very token object.
   */
  async hookLiveness(hookId: string) {
    return serve(() => {
      const run = this.#currentRun();
      const live =
        run !== undefined &&
        !isTerminalWorkflowRunStatus(run.status) &&
        this.#hasLiveHook(hookId);
      if (live) return 'live';
      const created = this.#log.some(
        (e) => e.eventType === 'hook_created' && e.correlationId === hookId
      );
      if (!created) this.ctx.storage.kv.put(`${FENCE_PREFIX}${hookId}`, true);
      return 'dead';
    });
  }

  async alarm() {
    debug('alarm', this.#runId);
    this.#alarmAt = undefined;
    this.#drive();
  }

  /** Test hook: drop this instance, as a deploy or eviction would. */
  async reset() {
    this.ctx.abort('reset requested');
  }

  // ---------------------------------------------------------------------------
  // Storage

  async #load() {
    const kv = this.ctx.storage.kv;
    this.#runId = kv.get<string>('runId');
    const log = [...kv.list<Event>({ prefix: EVENT_PREFIX })].map(
      ([, event]) => event
    );
    this.#store = createSimStore({
      now: () => Math.max(Date.now(), this.#lastCreatedAtMs),
      ids: {
        ulid: () => this.#messageIds(),
        runId: () => `wrun_${this.#messageIds()}`,
        messageId: () => `msg_${this.#messageIds()}`,
        count: () => 0,
      },
      onEvent: (event) => this.#appended.push(event),
    });
    this.#store.seedFromLog(log);
    this.#log = log;
    for (const event of log) this.#noteCreatedAt(event);

    for (const [, signal] of kv.list<Signal>({ prefix: SIGNAL_PREFIX })) {
      // A delivery a previous instance had in flight died with it (this
      // instance exists only because that one is gone): that was a failed
      // attempt, and the redelivery says so.
      if (signal.delivering) {
        signal.delivering = false;
        signal.attempt++;
        this.#store_(signal);
      }
      this.#signals.set(signal.messageId, signal);
    }
    debug(
      'loaded',
      this.#runId,
      `${log.length} events`,
      `${this.#signals.size} signals`
    );
    await this.#scheduleAlarm();
  }

  #noteCreatedAt(event: Event) {
    const ms = new Date(event.createdAt).getTime();
    if (ms > this.#lastCreatedAtMs) this.#lastCreatedAtMs = ms;
  }

  #bindRun(runId: string) {
    if (this.#runId === runId) return;
    if (this.#runId !== undefined) {
      throw new WorkflowWorldError(
        `world-cloudflare: object for run ${this.#runId} asked about run ${runId}`,
        { status: 500 }
      );
    }
    this.#runId = runId;
    this.ctx.storage.kv.put('runId', runId);
  }

  async #withRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    if (this.#runId !== undefined && this.#runId !== runId) {
      throw new WorkflowRunNotFoundError(runId);
    }
    return fn();
  }

  #currentRun(): WorkflowRun | undefined {
    return this.#runId ? this.#store.allRuns()[0] : undefined;
  }

  #hasLiveHook(hookId: string): boolean {
    return this.#store.allHooks().some((hook) => hook.hookId === hookId);
  }

  #eventsCreate(
    runId: string,
    data: any,
    params?: CreateEventParams
  ): Promise<EventResult> {
    debug('events.create', data.eventType, data.correlationId ?? '');
    return this.#writes.run(async () => {
      this.#bindRun(runId);
      const internal: { externalTokenOwner?: string } = {};
      if (data.eventType === 'hook_created') {
        const owner = await this.#claimToken(
          runId,
          data.correlationId,
          data.eventData.token
        );
        if (owner) internal.externalTokenOwner = owner;
      }

      this.#appended = [];
      let result: EventResult;
      try {
        result = await this.#store.events.create(runId, data, {
          ...params,
          ...internal,
        } as CreateEventParams);
      } finally {
        this.#persistAppended();
      }

      await this.#afterCommit();
      return this.#withSkippedReport(runId, result, params);
    });
  }

  /**
   * Make every event the store just appended durable. A failure here leaves
   * the in-memory store ahead of storage, so the instance is dropped and the
   * next request rebuilds from what was persisted.
   */
  #persistAppended() {
    const appended = this.#appended;
    this.#appended = [];
    if (appended.length === 0) return;
    try {
      for (const event of appended) {
        this.ctx.storage.kv.put(
          eventKey(requireEventSlot(event.eventId)),
          event
        );
        this.#log.push(event);
        this.#noteCreatedAt(event);
      }
    } catch (error) {
      this.ctx.abort('event persistence failed');
      throw error;
    }
  }

  /**
   * Bump-and-report (see `CreateEventParams.eventCount`): a writer whose view
   * was behind gets the events it skipped over. Writes here are serialized, so
   * the committed slot is always the next free one; the report is what keeps
   * a writer's view a prefix of the log.
   */
  async #withSkippedReport(
    runId: string,
    result: EventResult,
    params?: CreateEventParams
  ): Promise<EventResult> {
    const known = params?.eventCount;
    if (known === undefined || !result.event || 'events' in result) {
      return result;
    }
    const slot = requireEventSlot(result.event.eventId);
    if (slot <= known + 1) return result;
    debug('reporting skipped slots', known + 1, 'to', slot - 1);
    const before = known > 0 ? this.#log[known - 1] : undefined;
    const page = await this.#store.events.list({
      runId,
      pagination: {
        sortOrder: 'asc',
        limit: slot - 1 - known,
        ...(before
          ? {
              cursor: `${new Date(before.createdAt).toISOString()}|${before.eventId}`,
            }
          : {}),
      },
      resolveData: params?.resolveData ?? 'all',
    });
    return {
      ...result,
      events: page.data,
      cursor: page.cursor,
      hasMore: false,
    };
  }

  /**
   * Claim `token` for `hookId` in the cross-run registry before the
   * `hook_created` commits. Returns the run that holds it, if another does.
   */
  async #claimToken(
    runId: string,
    hookId: string,
    token: string
  ): Promise<string | undefined> {
    const kv = this.ctx.storage.kv;
    for (let attempt = 0; attempt < 5; attempt++) {
      kv.delete(`${FENCE_PREFIX}${hookId}`);
      const claim = await call<ClaimResult>(
        TOKENS_BINDING,
        `token:${token}`,
        'claim',
        runId,
        hookId
      );
      if (!claim.granted) return claim.ownerRunId;
      await call(TOKENS_BINDING, `hook:${hookId}`, 'record', runId);
      // A liveness check that ran while we awaited may have declared this
      // hook dead and handed the token on. Checked with no await between it
      // and the commit, so it cannot change underneath us.
      if (!kv.get(`${FENCE_PREFIX}${hookId}`)) return undefined;
    }
    throw new WorkflowWorldError(
      `world-cloudflare: could not settle ownership of hook token for ${hookId}`,
      { status: 503 }
    );
  }

  /** Housekeeping after any commit: schedule new wait deadlines, etc. */
  async #afterCommit() {
    const run = this.#currentRun();
    if (run && isTerminalWorkflowRunStatus(run.status)) {
      // A finished run has nothing left to execute; drop pending signals
      // except those already being delivered (they will finish on their own).
      for (const signal of [...this.#signals.values()]) {
        if (!this.#inflight.has(signal.messageId)) this.#remove(signal);
      }
    }
    await this.#scheduleAlarm();
  }

  // ---------------------------------------------------------------------------
  // Execution signals

  async #enqueue(
    queueName: ValidQueueName,
    message: QueuePayload,
    opts?: QueueOptions
  ): Promise<{ messageId: MessageId }> {
    const runId = (message as { runId?: string }).runId;
    debug(
      'enqueue',
      Object.keys(message),
      opts?.idempotencyKey ?? '',
      opts?.delaySeconds ?? 0
    );
    const isHealthCheck = '__healthCheck' in message;
    if (runId && !isHealthCheck) this.#bindRun(runId);
    const kv = this.ctx.storage.kv;
    const key = opts?.idempotencyKey;
    if (key) {
      const existing = kv.get<MessageId>(`${KEY_PREFIX}${key}`);
      if (existing && this.#signals.has(existing)) {
        return { messageId: existing };
      }
    }
    const signal: Signal = {
      messageId: `msg_${this.#messageIds()}` as MessageId,
      queueName,
      message,
      kind:
        'stepId' in message && typeof message.stepId === 'string'
          ? 'step'
          : 'flow',
      runAt: Date.now() + Math.max(0, opts?.delaySeconds ?? 0) * 1000,
      attempt: 1,
      ...(key ? { idempotencyKey: key } : {}),
    };
    kv.put(`${SIGNAL_PREFIX}${signal.messageId}`, signal);
    if (key) kv.put(`${KEY_PREFIX}${key}`, signal.messageId);
    this.#signals.set(signal.messageId, signal);
    // The backstop alarm is armed before the reply leaves (output gate), so a
    // stored signal always has something durable that will deliver it.
    await this.#scheduleAlarm();
    queueMicrotask(() => this.#drive());
    return { messageId: signal.messageId };
  }

  #store_(signal: Signal) {
    this.ctx.storage.kv.put(`${SIGNAL_PREFIX}${signal.messageId}`, signal);
  }

  #remove(signal: Signal) {
    const kv = this.ctx.storage.kv;
    kv.delete(`${SIGNAL_PREFIX}${signal.messageId}`);
    if (
      signal.idempotencyKey &&
      kv.get(`${KEY_PREFIX}${signal.idempotencyKey}`) === signal.messageId
    ) {
      kv.delete(`${KEY_PREFIX}${signal.idempotencyKey}`);
    }
    this.#signals.delete(signal.messageId);
  }

  #reschedule(signal: Signal, delayMs: number, failed: boolean) {
    if (!this.#signals.has(signal.messageId)) return;
    signal.delivering = false;
    signal.runAt = Date.now() + delayMs;
    if (failed) {
      signal.attempt++;
      if (signal.attempt > MAX_ATTEMPTS) {
        signal.parked = `gave up after ${MAX_ATTEMPTS} attempts`;
        console.error(
          `[world-cloudflare] ${signal.messageId}: ${signal.parked}`
        );
      }
    }
    this.#store_(signal);
  }

  /** Start whatever is due. Never awaits: deliveries run in the background. */
  #drive() {
    const now = Date.now();
    this.#completeDueWaits(now);
    const due = [...this.#signals.values()]
      .filter(
        (s) =>
          !s.parked &&
          !this.#pinned.has(s.messageId) &&
          s.runAt <= now &&
          !this.#inflight.has(s.messageId)
      )
      .sort(
        (a, b) => a.runAt - b.runAt || (a.messageId < b.messageId ? -1 : 1)
      );
    for (const signal of due) {
      if (signal.kind !== 'step') continue;
      if (this.#stepDeliveries >= MAX_STEP_DELIVERIES) break;
      this.#background(this.#deliverStep(signal));
    }
    if (!this.#flowBusy) {
      const next = due.find((s) => s.kind === 'flow');
      if (next) this.#background(this.#deliverFlow(next, due));
    }
    void this.#scheduleAlarm();
  }

  #background(task: Promise<void>) {
    this.ctx.waitUntil(
      task
        .catch((error) =>
          console.error('[world-cloudflare] delivery task failed', error)
        )
        .finally(() => this.#drive())
    );
  }

  /** Is this signal's run pinned to a different build than this isolate? */
  #pinnedDeployment(signal: Signal): string | undefined {
    if ('__healthCheck' in signal.message) return undefined;
    const message = signal.message as {
      runInput?: { deploymentId?: string };
    };
    const runDeployment =
      this.#currentRun()?.deploymentId ?? message.runInput?.deploymentId;
    const ours = getRuntimeConfig().deploymentId;
    return runDeployment && runDeployment !== ours ? runDeployment : undefined;
  }

  /** Hold a signal back for the life of this instance; nothing runs it here. */
  #holdForOtherBuild(signal: Signal, reason: string) {
    signal.delivering = false;
    this.#store_(signal);
    this.#pinned.add(signal.messageId);
    console.error(`[world-cloudflare] holding ${signal.messageId}: ${reason}`);
  }

  #meta(signal: Signal): DeliveryMeta {
    signal.delivering = true;
    this.#store_(signal);
    return {
      attempt: signal.attempt,
      queueName: signal.queueName,
      messageId: signal.messageId,
    };
  }

  /** Apply a delivery's outcome to its signal. */
  #settle(signal: Signal, result: unknown, error: unknown) {
    if (error !== undefined) {
      const backoff = Math.min(60_000, 1000 * 2 ** (signal.attempt - 1));
      console.error(
        `[world-cloudflare] delivery ${signal.messageId} attempt ${signal.attempt} failed`,
        error
      );
      this.#reschedule(signal, backoff, true);
      return;
    }
    const timeout = (result as { timeoutSeconds?: unknown } | undefined)
      ?.timeoutSeconds;
    if (typeof timeout === 'number') {
      // "Redeliver this message later": control flow, not a failure.
      this.#reschedule(signal, Math.max(0, timeout) * 1000, false);
      return;
    }
    this.#remove(signal);
  }

  async #deliverFlow(signal: Signal, due: Signal[]) {
    this.#flowBusy = true;
    this.#inflight.add(signal.messageId);
    // Plain wakes are interchangeable: one replay covers every wake that was
    // already stored when it started, since each was stored only after the
    // event it announces was durable.
    const absorbed = isPlainWake(signal.message)
      ? due.filter(
          (s) =>
            s !== signal &&
            s.kind === 'flow' &&
            isPlainWake(s.message) &&
            !this.#inflight.has(s.messageId)
        )
      : [];
    for (const s of absorbed) this.#inflight.add(s.messageId);
    try {
      const pinned = this.#pinnedDeployment(signal);
      if (pinned) {
        this.#holdForOtherBuild(
          signal,
          `run is pinned to deployment ${pinned}; this isolate runs ${getRuntimeConfig().deploymentId}`
        );
        return;
      }
      let result: unknown;
      let error: unknown;
      debug(
        'flow delivery start',
        signal.messageId,
        `attempt ${signal.attempt}`,
        Object.keys(signal.message),
        `absorbed ${absorbed.length}`
      );
      try {
        result = await runAsLocal(
          { runId: this.#runId ?? '', object: this },
          () => deliver(signal.message, this.#meta(signal), this.#flow())
        );
      } catch (e) {
        error = e ?? new Error('delivery failed');
      }
      debug(
        'flow delivery end',
        signal.messageId,
        error ? `error ${String(error)}` : JSON.stringify(result)
      );
      for (const s of absorbed) this.#remove(s);
      this.#settle(signal, result, error);
    } finally {
      this.#inflight.delete(signal.messageId);
      for (const s of absorbed) this.#inflight.delete(s.messageId);
      this.#flowBusy = false;
    }
  }

  async #deliverStep(signal: Signal) {
    this.#stepDeliveries++;
    this.#inflight.add(signal.messageId);
    try {
      const pinned = this.#pinnedDeployment(signal);
      if (pinned) {
        this.#holdForOtherBuild(
          signal,
          `run is pinned to deployment ${pinned}`
        );
        return;
      }
      let result: unknown;
      let error: unknown;
      try {
        // A separate invocation of this Worker, so step bodies never run in
        // (or block) the run's own isolate.
        debug(
          'step delivery start',
          signal.messageId,
          (signal.message as { stepName?: string }).stepName
        );
        const runner = this.ctx.exports.StepRunner;
        result = unwrapInvocationOutcome(
          await runner.run(signal.message, this.#meta(signal))
        );
      } catch (e) {
        error = e ?? new Error('step delivery failed');
      }
      this.#settle(signal, result, error);
    } finally {
      this.#inflight.delete(signal.messageId);
      this.#stepDeliveries--;
    }
  }

  // ---------------------------------------------------------------------------
  // Timers

  /**
   * Complete waits whose deadline has passed. The workflow would do this
   * itself on its next replay; doing it here, at the deadline, puts the
   * `wait_completed` in the log at the right time even while the workflow is
   * busy running a step inline (`Promise.race([step(), sleep()])`).
   */
  #completeDueWaits(now: number) {
    const run = this.#currentRun();
    if (!run || isTerminalWorkflowRunStatus(run.status)) return;
    for (const wait of this.#store.allWaits()) {
      if (wait.status === 'completed' || !wait.resumeAt) continue;
      if (new Date(wait.resumeAt).getTime() > now) continue;
      const correlationId = wait.waitId.slice(run.runId.length + 1);
      if (this.#completingWaits.has(correlationId)) continue;
      this.#completingWaits.add(correlationId);
      this.ctx.waitUntil(
        (async () => {
          try {
            await this.#eventsCreate(run.runId, {
              eventType: 'wait_completed',
              specVersion: run.specVersion ?? SPEC_VERSION_CURRENT,
              correlationId,
              eventData: { resumeAt: wait.resumeAt },
            });
            await this.#enqueue(this.#queueName(run), { runId: run.runId });
          } catch (error) {
            if (!EntityConflictError.is(error)) {
              console.error('[world-cloudflare] completing wait failed', error);
            }
          } finally {
            this.#completingWaits.delete(correlationId);
          }
        })()
      );
    }
  }

  async #scheduleAlarm() {
    let next: number | undefined;
    const consider = (ms: number) => {
      if (next === undefined || ms < next) next = ms;
    };
    for (const signal of this.#signals.values()) {
      if (signal.parked || this.#inflight.has(signal.messageId)) continue;
      consider(
        this.#pinned.has(signal.messageId)
          ? Date.now() + PINNED_RECHECK_MS
          : signal.runAt
      );
    }
    const run = this.#currentRun();
    if (run && !isTerminalWorkflowRunStatus(run.status)) {
      for (const wait of this.#store.allWaits()) {
        if (wait.status !== 'completed' && wait.resumeAt) {
          consider(new Date(wait.resumeAt).getTime());
        }
      }
    }
    if (this.#inflight.size > 0) consider(Date.now() + BACKSTOP_MS);
    const target = next ?? null;
    if (target === this.#alarmAt) return;
    this.#alarmAt = target;
    debug(
      'alarm at',
      target === null ? 'none' : new Date(target).toISOString()
    );
    if (target === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(target);
  }

  #queueName(run: Pick<WorkflowRun, 'workflowName'>): ValidQueueName {
    return `${getQueueTopicPrefix('workflow')}${run.workflowName}` as ValidQueueName;
  }

  // ---------------------------------------------------------------------------
  // invoke(): inputs for the running workflow

  async #invoke(
    runId: string,
    payload: unknown,
    options?: InvokeOptions
  ): Promise<InvocationOutcome> {
    this.#bindRun(runId);
    const kv = this.ctx.storage.kv;
    const requestId = options?.idempotencyKey ?? `inv_${this.#messageIds()}`;
    const stored = kv.get<InvocationOutcome>(`${INVOKE_PREFIX}${requestId}`);
    if (stored) return stored;
    const run = this.#currentRun();
    if (!run) throw new WorkflowRunNotFoundError(runId);
    const queueName = this.#queueName(run);
    const outcome = await captureInvocationOutcome(
      () =>
        runAsLocal({ runId, object: this }, () =>
          deliver(
            { runId, invoke: true, requestId, input: payload },
            {
              attempt: 1,
              queueName,
              messageId: `msg_${this.#messageIds()}` as MessageId,
            },
            this.#flow()
          )
        ),
      isTerminalInvocationError
    );
    kv.put(`${INVOKE_PREFIX}${requestId}`, outcome);
    if (
      outcome.ok &&
      (outcome.value as { status?: string } | undefined)?.status === 'accepted'
    ) {
      // The input is durable; make sure a runner picks it up. A pass already
      // running sees it through core's input activity, and a pass that has
      // already finished is followed by this one.
      await this.#enqueue(queueName, { runId });
    }
    return outcome;
  }
}
