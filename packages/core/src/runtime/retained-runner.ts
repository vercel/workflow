import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import {
  EntityConflictError,
  PreconditionFailedError,
  RUN_ERROR_CODES,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { globalSingleton, withResolvers } from '@workflow/utils';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  type EventResult,
  type EventWriteSession,
  getEventDataPayloadField,
  HealthCheckPayloadSchema,
  isTerminalWorkflowRunStatus,
  type Queue,
  type QueuePrefix,
  type RunCreatedEventRequest,
  requireEventSlot,
  SPEC_VERSION_CURRENT,
  type Step,
  WorkflowInvokePayloadSchema,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { getStepFunction } from '../private.js';
import { ReplayPayloadCache } from '../replay-payload-cache.js';
import type { PayloadKey } from '../serialization/encryption.js';
import { dehydrateRunError, dehydrateStepError } from '../serialization.js';
import { serializeTraceCarrier } from '../telemetry.js';
import {
  replayWorkflow,
  resumeWorkflow,
  type WorkflowSession,
} from '../workflow.js';
import { observeWorkflowPass } from './execution-observation.js';
import { resolveRunEncryptionKey } from './helpers.js';
import { HookInvocationSchema, withRunInputs } from './invocations.js';
import {
  executeOwnedStep,
  isOwnedStepMessage,
  isStepOutcome,
  OwnedStepResultSchema,
  OwnedStepStatusSchema,
  QueuedStepPolicySchema,
  stepOutcomeDigest,
} from './owned-step.js';
import { DEFAULT_STEP_MAX_RETRIES, executeStep } from './step-executor.js';
import { handleSuspension } from './suspension-handler.js';
import { useQuickJSVm } from './vm-mode.js';
import { withScopedWorld } from './world.js';

type Handler = Parameters<Queue['createQueueHandler']>[1];
type LegacyHandler = Parameters<ReturnType<typeof withRunInputs>>[0];
type Metadata = Parameters<Handler>[1];
const observations = channel('workflow.runner');

export function retainedRunnerEnabled() {
  return process.env.WORKFLOW_RETAINED_RUNNER === '1';
}

class RunnerFault extends WorkflowRuntimeError {
  readonly code = 'RETAINED_RUNNER_FAILED';
  terminalPersisted?: boolean;
  constructor(
    readonly kind: 'persistence' | 'conflict' | 'execution',
    cause: unknown,
    readonly conflictReason?: string
  ) {
    super(
      `Retained runner ${kind} failure${conflictReason ? ` (${conflictReason})` : ''}`,
      { cause }
    );
  }
}
class InputRejected extends WorkflowWorldError {}

interface MailboxItem {
  id: string;
  run(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function equivalent(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (actual === expected) return true;
  if (expected instanceof Uint8Array)
    return (
      actual instanceof Uint8Array &&
      Buffer.from(actual).equals(Buffer.from(expected))
    );
  if (expected instanceof Date)
    return new Date(actual as string).getTime() === expected.getTime();
  if (
    expected &&
    typeof expected === 'object' &&
    actual &&
    typeof actual === 'object'
  ) {
    return Object.entries(expected).every(
      ([key, value]) =>
        value === undefined ||
        equivalent((actual as Record<string, unknown>)[key], value)
    );
  }
  return false;
}

function isLazyPayload(value: unknown): boolean {
  return (
    value === undefined ||
    (value !== null &&
      typeof value === 'object' &&
      '_type' in value &&
      value._type === 'RemoteRef' &&
      '_ref' in value &&
      typeof value._ref === 'string' &&
      value._ref.length > 0)
  );
}

/** A write acknowledgement may carry a reference rather than echoing payload bytes. */
function materializeEventPayload(
  actual: Event,
  known: { eventType: string; eventData?: unknown }
): Event {
  const field = getEventDataPayloadField(known.eventType);
  if (!field || !known.eventData || typeof known.eventData !== 'object')
    return actual;
  const payload = (known.eventData as Record<string, unknown>)[field];
  if (
    !(payload instanceof Uint8Array) ||
    !isLazyPayload(
      (actual.eventData as Record<string, unknown> | undefined)?.[field]
    )
  )
    return actual;
  return {
    ...actual,
    eventData: { ...actual.eventData, [field]: payload.slice() },
  } as Event;
}

function materializeEntityPayloads<T extends object>(
  entity: T,
  known: Record<string, unknown>
): T {
  const materialized = { ...entity } as Record<string, unknown>;
  for (const field of ['input', 'output', 'error', 'metadata']) {
    const payload = known[field];
    if (payload instanceof Uint8Array && isLazyPayload(materialized[field])) {
      materialized[field] = payload.slice();
      delete materialized[`${field}Ref`];
    }
  }
  return materialized as T;
}

/** One owner, one mailbox and one committed projection. Transport supplies exclusion. */
export class RetainedRunner {
  readonly id = randomUUID();
  readonly facade: World;
  readonly events: Event[] = [];
  private runState?: WorkflowRun;
  private steps = new Map<string, Step>();
  private hooks = new Map<string, { token: string; active: boolean }>();
  private processed = new Map<
    string,
    { hookId: string; token: string; digest: string }
  >();
  private session?: WorkflowSession;
  private key?: PayloadKey;
  private payloadCache?: ReplayPayloadCache;
  private initialized = false;
  private eventWriter?: EventWriteSession;
  private failureCommitted = false;
  private loopIteration = 0;
  private pending: MailboxItem[] = [];
  private signal?: () => void;
  private fault?: RunnerFault;
  private failurePromise?: Promise<void>;
  private commitTail: Promise<unknown> = Promise.resolve();
  private inTurn = new AsyncLocalStorage<boolean>();
  private workers = new Map<string, Promise<void>>();
  private localWorkers = new Set<string>();
  private timerWakeups = new Set<string>();
  private lifetime?: Promise<void>;
  private closing = false;
  private deadline = Infinity;
  private currentTurnId?: string;
  private stepStarts = new Map<string, { event: Event; attempt: number }>();
  private stepOutcomes = new Map<
    string,
    { event: Event; digest: string; attempt: number }
  >();
  private recoveryWakeAt = 0;

  private get queuedSteps() {
    const value = this.runState?.executionContext?.stepExecution;
    return value ? QueuedStepPolicySchema.parse(value) : undefined;
  }

  private get run(): WorkflowRun {
    if (!this.runState)
      throw new WorkflowRuntimeError('Runner has no loaded snapshot');
    return this.runState;
  }

  private get replayCache(): ReplayPayloadCache {
    if (!this.payloadCache)
      throw new WorkflowRuntimeError('Runner has no payload cache');
    return this.payloadCache;
  }

  constructor(
    private readonly backend: World,
    readonly runId: string,
    private readonly prefix: QueuePrefix,
    private readonly workflowCode: string,
    private readonly metadata: Metadata,
    private readonly retire: () => void,
    private readonly idleMs = 60_000
  ) {
    this.facade = {
      ...backend,
      runs: {
        ...backend.runs,
        get: (async (id: string, options?: unknown) =>
          id === runId && this.runState
            ? this.runState
            : backend.runs.get(id, options as never)) as World['runs']['get'],
      },
      steps: {
        ...backend.steps,
        get: (async (id: string, stepId: string, options?: unknown) => {
          if (id !== runId)
            return backend.steps.get(id, stepId, options as never);
          const step = this.steps.get(stepId);
          if (!step)
            throw new WorkflowRuntimeError(
              'Step is absent from the owner snapshot'
            );
          return step;
        }) as World['steps']['get'],
      },
      events: {
        ...backend.events,
        create: ((
          id: string | null,
          event: CreateEventRequest | RunCreatedEventRequest,
          options?: CreateEventParams
        ) => {
          if (event.eventType === 'run_created')
            return backend.events.create(id, event, options);
          if (id === null)
            throw new WorkflowRuntimeError(
              'Only run creation accepts a null run ID'
            );
          if (id !== runId) {
            return backend.events.create(id, event, options);
          }
          if (this.inTurn.getStore()) return this.commit(event, options);
          return this.enqueue(`event:${event.eventType}`, async () => {
            if (
              this.runState &&
              isTerminalWorkflowRunStatus(this.runState.status)
            )
              throw new InputRejected('Workflow is terminal', { status: 410 });
            const result = await this.commit(event, options);
            if (
              event.eventType === 'step_completed' ||
              event.eventType === 'step_failed'
            )
              await this.advance();
            return result;
          });
        }) as World['events']['create'],
        // Let suspension handling use its ordinary single-event path. It must
        // not classify a partially accepted batch as a concurrency recovery.
        createBatch: undefined,
        createWriteSession: undefined,
        list: async (params) =>
          params.runId === runId
            ? { data: [...this.events], hasMore: false, cursor: null }
            : backend.events.list(params),
        listByCorrelationId: async (params) =>
          params.runId === runId
            ? {
                data: this.events.filter(
                  (event) => event.correlationId === params.correlationId
                ),
                hasMore: false,
                cursor: null,
              }
            : backend.events.listByCorrelationId(params),
      },
    };
  }

  private observe(
    phase: string,
    event: 'begin' | 'end',
    spanId: string,
    details: Record<string, unknown> = {}
  ) {
    if (observations.hasSubscribers)
      observations.publish({
        version: 1,
        runId: this.runId,
        ownerId: this.id,
        phase,
        event,
        spanId,
        parentSpanId: phase === 'turn' ? undefined : this.currentTurnId,
        at: Date.now(),
        ...details,
      });
  }

  enqueue(id: string, operation: () => Promise<unknown>): Promise<unknown> {
    if (this.fault) return Promise.reject(this.fault);
    if (this.closing)
      return Promise.reject(
        new WorkflowWorldError('Runner is retiring', { status: 409 })
      );
    if (this.pending.length >= (this.queuedSteps?.mode === 'hybrid' ? 128 : 32))
      return Promise.reject(
        new WorkflowWorldError('Runner mailbox is full', { status: 429 })
      );
    const completion = withResolvers<unknown>();
    this.pending.push({
      id,
      run: AsyncResource.bind(() => this.runOperation(id, operation)),
      resolve: completion.resolve,
      reject: completion.reject,
    });
    this.signal?.();
    this.lifetime ??= this.runOwnerLoop();
    return completion.promise;
  }

  async retain() {
    const { waitUntil } = await import('@vercel/functions');
    if (this.lifetime) waitUntil(this.lifetime);
  }

  submit(message: unknown, metadata: Metadata) {
    const parsed = WorkflowInvokePayloadSchema.parse(message);
    return this.enqueue(parsed.requestId ?? metadata.messageId, async () => {
      await this.initialize();
      if (`${this.prefix}${this.run.workflowName}` !== metadata.queueName)
        throw new InputRejected('Invocation target mismatch', { status: 409 });
      if (parsed.invoke) {
        if (
          parsed.input &&
          typeof parsed.input === 'object' &&
          'type' in parsed.input &&
          (parsed.input.type === 'step_result' ||
            parsed.input.type === 'step_status')
        ) {
          return this.receiveStepInput(parsed.input);
        }
        if (
          parsed.input &&
          typeof parsed.input === 'object' &&
          'type' in parsed.input &&
          parsed.input.type === 'run_start'
        ) {
          // Start delivered to this owner rather than through the queue. The
          // run is already durably created; a repeated start only re-advances.
          if ((parsed.input as { version?: unknown }).version !== 1)
            throw new InputRejected('Invalid start input', { status: 400 });
          // A retained session means the run already advanced to a
          // suspension; re-advancing without new events is not a valid resume.
          if (!this.session && !isTerminalWorkflowRunStatus(this.run.status))
            await this.advance();
          return { status: 'accepted' };
        }
        if (
          parsed.input &&
          typeof parsed.input === 'object' &&
          'type' in parsed.input &&
          parsed.input.type === 'run_cancel'
        ) {
          const cancel = parsed.input as {
            version?: unknown;
            cancelReason?: unknown;
          };
          if (
            cancel.version !== 1 ||
            (cancel.cancelReason !== undefined &&
              (typeof cancel.cancelReason !== 'string' ||
                cancel.cancelReason.length > 512))
          )
            throw new InputRejected('Invalid cancellation input', {
              status: 400,
            });
          if (!isTerminalWorkflowRunStatus(this.run.status))
            await this.commit({
              eventType: 'run_cancelled',
              specVersion: SPEC_VERSION_CURRENT,
              ...(typeof cancel.cancelReason === 'string'
                ? { eventData: { cancelReason: cancel.cancelReason } }
                : {}),
            });
          return;
        }
        const input = HookInvocationSchema.safeParse(parsed.input);
        if (!input.success || !parsed.requestId)
          throw new InputRejected('Invalid hook input', { status: 400 });
        if (this.run.status === 'failed' || this.run.status === 'cancelled')
          throw new InputRejected('Workflow is terminal', { status: 410 });
        if (!this.session && !isTerminalWorkflowRunStatus(this.run.status))
          await this.advance();
        const digest = createHash('sha256')
          .update(input.data.payload)
          .digest('hex');
        const prior = this.processed.get(parsed.requestId);
        if (prior) {
          if (
            prior.hookId !== input.data.hookId ||
            prior.token !== input.data.token ||
            prior.digest !== digest
          )
            throw new InputRejected(
              'Input identity reused with different contents',
              { status: 409 }
            );
          return { status: 'accepted' };
        }
        const hook = this.hooks.get(input.data.hookId);
        if (
          !hook?.active ||
          hook.token !== input.data.token ||
          isTerminalWorkflowRunStatus(this.run.status)
        )
          throw new InputRejected('Hook not found', { status: 404 });
        await this.commit(
          {
            eventType: 'hook_received',
            correlationId: input.data.hookId,
            specVersion: SPEC_VERSION_CURRENT,
            eventData: { token: input.data.token, payload: input.data.payload },
          },
          { resumeId: parsed.requestId, resumePayloadDigest: digest }
        );
        await this.advance();
        return { status: 'accepted' };
      }
      if (!isTerminalWorkflowRunStatus(this.run.status)) await this.advance();
    });
  }

  private async observed<T>(
    phase: string,
    operation: () => Promise<T>,
    details: Record<string, unknown> = {},
    spanId = randomUUID()
  ): Promise<T> {
    const started = performance.now();
    this.observe(phase, 'begin', spanId, details);
    try {
      const result = await operation();
      this.observe(phase, 'end', spanId, {
        ...details,
        status: 'completed',
        elapsedMs: performance.now() - started,
      });
      return result;
    } catch (error) {
      this.observe(phase, 'end', spanId, {
        ...details,
        status: 'error',
        elapsedMs: performance.now() - started,
      });
      throw error;
    }
  }

  private async initialize() {
    if (this.initialized) return;
    const spanId = randomUUID();
    return this.observed(
      'initialize',
      () => this.initializeSnapshot(spanId),
      {},
      spanId
    );
  }

  private async initializeSnapshot(parentSpanId: string) {
    this.eventWriter ??= this.backend.events.createWriteSession?.(this.runId);
    if (Boolean(this.eventWriter?.stage) !== Boolean(this.eventWriter?.flush))
      throw new RunnerFault(
        'persistence',
        new Error('Buffered writer requires both stage and flush')
      );
    const history: Event[] = [];
    const steps: Step[] = [];
    const reads = this.eventWriter?.reads;
    await reads?.ready?.();
    const eventReads = { parentSpanId, pageCount: 0, eventCount: 0 };
    const stepReads = { parentSpanId, pageCount: 0, stepCount: 0 };
    // Run bootstrap reads in parallel after any session channel is ready.
    // Each task owns its partial results until all snapshot reads have succeeded.
    const snapshot = await Promise.allSettled([
      this.observed(
        'load_run',
        async () => {
          this.runState = await (reads?.getRun(this.runId) ??
            this.backend.runs.get(this.runId));
          if (this.runState.executionContext?.retainedRunnerVersion !== 1)
            throw new InputRejected(
              'Run was not created for retained execution',
              {
                status: 409,
              }
            );
          if (useQuickJSVm(this.runState))
            throw new RunnerFault(
              'execution',
              new Error('Retained runner requires the Node VM')
            );
          if (this.runState.expiredAt)
            throw new InputRejected('Workflow has expired', { status: 410 });
          if (
            `${this.prefix}${this.runState.workflowName}` !==
            this.metadata.queueName
          )
            throw new InputRejected('Invocation target mismatch', {
              status: 409,
            });
          if (
            this.backend.capabilities?.deploymentAffinity &&
            process.env.VERCEL_DEPLOYMENT_ID &&
            this.runState.deploymentId !== process.env.VERCEL_DEPLOYMENT_ID
          )
            throw new InputRejected('Pinned deployment mismatch', {
              status: 409,
            });
          this.deadline =
            (await this.backend.getRuntimeDeadline?.())?.getTime() ?? Infinity;
          this.key = await resolveRunEncryptionKey(this.backend, this.runState);
          this.payloadCache = new ReplayPayloadCache(this.key);
        },
        { parentSpanId }
      ),
      this.observed(
        'load_events',
        async () => {
          let cursor: string | null = null;
          do {
            const page = await (
              reads?.listEvents ??
              this.backend.events.list.bind(this.backend.events)
            )({
              runId: this.runId,
              resolveData: 'all',
              pagination: {
                limit: 100,
                sortOrder: 'asc',
                ...(cursor ? { cursor } : {}),
              },
            });
            history.push(...page.data);
            eventReads.pageCount++;
            eventReads.eventCount = history.length;
            cursor = page.hasMore ? page.cursor : null;
          } while (cursor);
        },
        eventReads
      ),
      this.observed(
        'load_steps',
        async () => {
          let cursor: string | null = null;
          do {
            const page: {
              data: Step[];
              hasMore: boolean;
              cursor: string | null;
            } = await (
              reads?.listSteps ??
              this.backend.steps.list.bind(this.backend.steps)
            )({
              runId: this.runId,
              resolveData: 'all',
              pagination: { limit: 100, ...(cursor ? { cursor } : {}) },
            });
            steps.push(...page.data);
            stepReads.pageCount++;
            stepReads.stepCount = steps.length;
            cursor = page.hasMore ? page.cursor : null;
          } while (cursor);
        },
        stepReads
      ),
    ]);
    const failed = snapshot.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    await this.observed(
      'apply_history',
      async () => {
        for (const event of history) {
          if (requireEventSlot(event.eventId) !== this.events.length + 1)
            throw new RunnerFault(
              'conflict',
              new Error('Initial event history is not contiguous')
            );
          this.apply(event);
        }
        for (const step of steps) this.steps.set(step.stepId, step);
      },
      { parentSpanId, eventCount: history.length, stepCount: steps.length }
    );
    this.initialized = true;
    if (!isTerminalWorkflowRunStatus(this.run.status) && !this.run.startedAt)
      await this.commit({
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
      });
  }

  private apply(event: Event) {
    this.events.push(event);
    if (event.eventType === 'step_started') {
      this.stepStarts.set(event.correlationId, {
        event,
        attempt: (this.stepStarts.get(event.correlationId)?.attempt ?? 0) + 1,
      });
    } else if (this.queuedSteps && isStepOutcome(event)) {
      const start = this.stepStarts.get(event.correlationId!);
      if (start)
        this.stepOutcomes.set(start.event.eventId, {
          event,
          digest: stepOutcomeDigest(event),
          attempt: start.attempt,
        });
    }
    if (this.runState) {
      if (event.eventType === 'run_started')
        Object.assign(this.runState, {
          status: 'running',
          startedAt: this.runState.startedAt ?? event.createdAt,
        });
      if (event.eventType === 'run_completed')
        Object.assign(this.runState, {
          status: 'completed',
          completedAt: event.createdAt,
          output: event.eventData.output,
        });
      if (event.eventType === 'run_failed')
        Object.assign(this.runState, {
          status: 'failed',
          completedAt: event.createdAt,
          error: event.eventData.error,
        });
      if (event.eventType === 'run_cancelled')
        Object.assign(this.runState, {
          status: 'cancelled',
          completedAt: event.createdAt,
        });
    }
    if (event.eventType === 'hook_created')
      this.hooks.set(event.correlationId, {
        token: event.eventData.token,
        active: true,
      });
    if (event.eventType === 'hook_disposed') {
      const hook = this.hooks.get(event.correlationId);
      if (hook) hook.active = false;
    }
    if (
      event.eventType === 'hook_received' &&
      event.resumeId &&
      event.eventData.payload instanceof Uint8Array
    ) {
      const token =
        event.eventData.token ?? this.hooks.get(event.correlationId)?.token;
      if (token)
        this.processed.set(event.resumeId, {
          hookId: event.correlationId,
          token,
          digest: createHash('sha256')
            .update(event.eventData.payload)
            .digest('hex'),
        });
    }
  }

  private validateStepTransition(event: CreateEventRequest) {
    if (
      ![
        'step_created',
        'step_started',
        'step_completed',
        'step_failed',
        'step_retrying',
      ].includes(event.eventType)
    )
      return;
    const invalid = (reason: string): never => {
      this.fault ??= new RunnerFault(
        'conflict',
        new Error('Invalid owner step transition'),
        reason
      );
      throw this.fault;
    };
    if (!event.correlationId) invalid('missing_step_id');
    const step = this.steps.get(event.correlationId!);
    if (event.eventType === 'step_created') {
      if (step) invalid('duplicate_step');
      return;
    }
    if (!step || ['completed', 'failed', 'cancelled'].includes(step.status))
      invalid('terminal_or_missing_step');
    if (event.eventType === 'step_started') {
      if (step!.retryAfter && +step!.retryAfter > Date.now())
        invalid('retry_not_due');
      const name = event.eventData?.stepName;
      if (typeof name === 'string' && name !== step!.stepName)
        invalid('step_name');
    }
  }

  private commit(
    event: CreateEventRequest,
    options?: CreateEventParams
  ): Promise<EventResult> {
    const work = this.commitTail.then(async () => {
      if (this.fault) throw this.fault;
      this.validateStepTransition(event);
      const field = getEventDataPayloadField(event.eventType);
      const payload = field
        ? (event.eventData as Record<string, unknown> | undefined)?.[field]
        : undefined;
      // Keep the bytes submitted by this turn stable across the asynchronous write.
      const submitted =
        field && payload instanceof Uint8Array
          ? ({
              ...event,
              eventData: { ...event.eventData, [field]: payload.slice() },
            } as CreateEventRequest)
          : event;
      const wire =
        field && payload instanceof Uint8Array
          ? ({
              ...submitted,
              eventData: { ...submitted.eventData, [field]: payload.slice() },
            } as CreateEventRequest)
          : submitted;
      const spanId = randomUUID();
      const phase = this.eventWriter?.stage ? 'stage' : 'persist';
      this.observe(phase, 'begin', spanId, { eventType: event.eventType });
      try {
        const params: CreateEventParams = {
          ...options,
          resolveData: 'none',
          eventCount: this.events.length,
          skipPreload: true,
        };
        const result = await (this.eventWriter
          ? (this.eventWriter.stage ?? this.eventWriter.create).call(
              this.eventWriter,
              wire,
              params
            )
          : this.backend.events.create(this.runId, wire, params));
        const conflict = (reason: string): never => {
          throw new RunnerFault(
            'conflict',
            new Error('Persistence returned an unexpected event transition'),
            reason
          );
        };
        const acknowledged = result.event;
        if (!acknowledged) return conflict('missing_event');
        if (acknowledged.runId !== this.runId) conflict('run_id');
        if (acknowledged.eventType !== event.eventType) conflict('event_type');
        if (
          options?.resumeId !== undefined &&
          acknowledged.resumeId !== options.resumeId
        )
          conflict('resume_id');
        if (!equivalent(acknowledged.correlationId, event.correlationId))
          conflict('correlation_id');
        let slot: number;
        try {
          slot = requireEventSlot(acknowledged.eventId);
        } catch {
          return conflict('invalid_slot');
        }
        if (slot !== this.events.length + 1) conflict('event_slot');
        if (
          result.events?.some(
            (reported) =>
              reported.eventId !== acknowledged.eventId &&
              !this.events.some(
                (known) =>
                  known.eventId === reported.eventId &&
                  equivalent(materializeEventPayload(reported, known), known)
              )
          )
        )
          conflict('reported_events');
        const committed = materializeEventPayload(acknowledged, submitted);
        if (!equivalent(committed.eventData, submitted.eventData)) {
          throw new RunnerFault(
            'conflict',
            new Error('Persistence returned conflicting event data'),
            'event_data'
          );
        }
        const eventData = (committed.eventData ?? {}) as Record<
          string,
          unknown
        >;
        const materialized: EventResult = { ...result, event: committed };
        if (result.run) {
          const known = { ...this.runState } as Record<string, unknown>;
          if (committed.eventType === 'run_completed')
            known.output = eventData.output;
          if (committed.eventType === 'run_failed')
            known.error = eventData.error;
          materialized.run = materializeEntityPayloads(result.run, known);
        }
        if (result.step) {
          const known = { ...this.steps.get(result.step.stepId) } as Record<
            string,
            unknown
          >;
          if (
            committed.eventType === 'step_created' ||
            committed.eventType === 'step_started'
          ) {
            if (eventData.input instanceof Uint8Array)
              known.input = eventData.input;
          }
          if (committed.eventType === 'step_completed')
            known.output = eventData.result;
          if (
            committed.eventType === 'step_failed' ||
            committed.eventType === 'step_retrying'
          )
            known.error = eventData.error;
          materialized.step = materializeEntityPayloads(result.step, known);
        }
        if (result.hook && committed.eventType === 'hook_created')
          materialized.hook = materializeEntityPayloads(result.hook, {
            metadata: eventData.metadata,
          });
        this.apply(committed);
        if (materialized.run) this.runState = materialized.run;
        if (materialized.step)
          this.steps.set(materialized.step.stepId, materialized.step);
        this.observe(phase, 'end', spanId, {
          eventType: event.eventType,
          status: 'completed',
          payloadSource: committed === result.event ? 'response' : 'submitted',
        });
        return materialized;
      } catch (cause) {
        this.fault =
          cause instanceof RunnerFault
            ? cause
            : new RunnerFault(
                EntityConflictError.is(cause) ||
                  PreconditionFailedError.is(cause)
                  ? 'conflict'
                  : 'persistence',
                cause
              );
        this.observe(phase, 'end', spanId, {
          eventType: event.eventType,
          status: 'error',
          errorCode: this.fault.kind,
          conflictReason: this.fault.conflictReason,
        });
        throw this.fault;
      }
    });
    this.commitTail = work.catch(() => {});
    return work;
  }

  private async advance() {
    if (!this.runState || isTerminalWorkflowRunStatus(this.runState.status))
      return;
    if (this.queuedSteps) await this.expireQueuedSteps();
    for (;;) {
      if (this.fault) throw this.fault;
      if (Date.now() >= this.deadline - 2000)
        throw new RunnerFault(
          'execution',
          new Error('Runner execution deadline reached')
        );
      await this.completeDueWaits();
      const before = this.events.length;
      if (!this.session)
        await this.observed(
          'replay_prewarm',
          () => this.replayCache.prewarm(this.runState!, this.events),
          { eventCount: this.events.length }
        );
      else await this.replayCache.prewarm(this.runState, this.events);
      const mode = this.session ? 'retained' : 'replay';
      const result = await observeWorkflowPass(
        {
          runId: this.runId,
          loopIteration: ++this.loopIteration,
          mode,
          parentSpanId: this.currentTurnId,
          ownerId: this.id,
        },
        async () =>
          this.session
            ? resumeWorkflow(this.session, this.events)
            : replayWorkflow({
                workflowCode: this.workflowCode,
                workflowRun: this.run,
                events: this.events,
                encryptionKey: this.key,
                replayPayloadCache: this.replayCache,
                worldCapabilities: this.facade.capabilities,
              })
      );
      if (result.type === 'replay')
        throw new RunnerFault(
          'execution',
          new Error('Retained VM could not resume')
        );
      if (result.type === 'completed') {
        await this.commit({
          eventType: 'run_completed',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { output: result.output },
        });
        this.session = undefined;
        return;
      }
      this.session = result.session;
      const handled = await handleSuspension({
        suspension: result.suspension,
        world: this.facade,
        run: this.runState,
        requestId: this.metadata.requestId,
        deferInlineSteps: false,
      });
      await handled.deferredBatchWork;
      if (this.fault) throw this.fault;
      if (handled.waitTimeout) {
        const wakeKey = handled.waitTimeout.correlationId;
        if (!this.timerWakeups.has(wakeKey)) {
          this.timerWakeups.add(wakeKey);
          await this.backend.queue(
            this.metadata.queueName,
            { runId: this.runId },
            {
              deploymentId: this.runState.deploymentId,
              delaySeconds: handled.waitTimeout.seconds,
              idempotencyKey: `retained-wait:${this.runId}:${wakeKey}`,
            }
          );
        }
      }
      const starts: Array<{
        step: Step;
        claimed?: Step & { startedAt: Date };
      }> = [];
      const policy = this.queuedSteps;
      if (policy) await this.armStepRecovery();
      let available =
        (policy?.mode === 'hybrid' ? 100 : 16) -
        [...this.steps.values()].filter((step) => step.status === 'running')
          .length;
      for (const step of this.steps.values()) {
        if (
          'retryAfter' in step &&
          step.retryAfter &&
          +step.retryAfter > Date.now()
        )
          continue;
        if (
          (step.status === 'pending' || step.status === 'running') &&
          !this.workers.has(step.stepId)
        ) {
          if (policy && (step.status === 'running' || available-- <= 0))
            continue;
          if (policy || this.eventWriter?.stage) {
            const result = await this.commit({
              eventType: 'step_started',
              correlationId: step.stepId,
              specVersion: SPEC_VERSION_CURRENT,
              eventData: { stepName: step.stepName },
            });
            if (!result.step?.startedAt)
              throw new RunnerFault(
                'persistence',
                new Error('Step start did not return its started state')
              );
            starts.push({
              step,
              claimed: { ...result.step, startedAt: result.step.startedAt },
            });
          } else starts.push({ step });
        }
      }
      // Tentative VM progress is private; user code needs a durable start prefix.
      if (starts.length) await this.flushWriter();
      const remote: Array<Step & { startedAt: Date }> = [];
      let localSlots =
        policy?.mode === 'hybrid' ? 3 - this.localWorkers.size : 0;
      for (const { step, claimed } of starts) {
        // Flush may replace tentative entities with the native materialization.
        const canonical = claimed ? this.steps.get(step.stepId) : undefined;
        if (claimed && !canonical?.startedAt)
          throw new RunnerFault(
            'persistence',
            new Error('Missing committed step start')
          );
        const admitted = canonical?.startedAt
          ? { ...canonical, startedAt: canonical.startedAt }
          : claimed;
        if (policy && localSlots-- <= 0) {
          if (!admitted)
            throw new RunnerFault(
              'persistence',
              new Error('Missing queued step admission')
            );
          remote.push(admitted);
        } else this.startStep(step, admitted);
      }
      if (remote.length)
        await this.dispatchSteps(remote, policy!.attemptTimeoutMs);
      if (this.events.length === before) return;
    }
  }

  private async flushWriter() {
    if (!this.eventWriter?.flush) return;
    const spanId = randomUUID();
    this.observe('flush', 'begin', spanId, { eventCount: this.events.length });
    try {
      const acknowledgements = await this.eventWriter.flush();
      if (acknowledgements) this.confirmStaged(acknowledgements);
      this.failureCommitted = this.runState?.status === 'failed';
      this.observe('flush', 'end', spanId, {
        status: 'completed',
        eventCount: this.events.length,
        ...(acknowledgements
          ? {
              committedEventCount: acknowledgements.length,
              committedEventTypes: acknowledgements
                .map((result) => result.event?.eventType)
                .join(','),
            }
          : {}),
      });
    } catch (cause) {
      this.fault ??=
        cause instanceof RunnerFault
          ? cause
          : new RunnerFault('persistence', cause);
      this.observe('flush', 'end', spanId, {
        status: 'error',
        errorCode: 'persistence',
      });
      throw this.fault;
    }
  }

  /** Confirm private VM progress against native persistence responses before it
   * can authorize a user step or become an acknowledged input. */
  private confirmStaged(results: readonly EventResult[]) {
    const conflict = (reason: string): never => {
      throw new RunnerFault(
        'conflict',
        new Error('Buffered persistence changed a tentative transition'),
        reason
      );
    };
    for (const result of results) {
      if (!result.event) conflict('missing_event');
      const event = result.event!;
      const slot = requireEventSlot(event.eventId);
      const tentative = this.events[slot - 1];
      if (
        !tentative ||
        event.runId !== this.runId ||
        event.eventType !== tentative.eventType ||
        event.resumeId !== tentative.resumeId ||
        !equivalent(event.correlationId, tentative.correlationId)
      )
        conflict('event_identity');
      const committed = materializeEventPayload(event, tentative);
      if (+committed.createdAt !== +tentative.createdAt)
        conflict('event_clock');
      if (!equivalent(committed.eventData, tentative.eventData))
        conflict('event_data');
      if (
        result.events?.some(
          (extra) =>
            extra.eventId !== event.eventId &&
            !this.events.some(
              (known) =>
                known.eventId === extra.eventId &&
                equivalent(materializeEventPayload(extra, known), known)
            )
        )
      )
        conflict('reported_events');
      this.events[slot - 1] = committed;
      const later = this.events.slice(slot);
      if (
        result.step &&
        !later.some(
          (next) =>
            next.correlationId === result.step!.stepId &&
            next.eventType.startsWith('step_')
        )
      ) {
        const known = this.steps.get(result.step.stepId);
        if (
          !known ||
          result.step.status !== known.status ||
          result.step.attempt !== known.attempt
        )
          conflict('step_state');
        this.steps.set(
          result.step.stepId,
          materializeEntityPayloads(result.step, { ...known })
        );
      }
      if (
        result.run &&
        !later.some((next) => next.eventType.startsWith('run_'))
      )
        this.runState = materializeEntityPayloads(result.run, {
          ...this.runState,
        });
    }
  }

  private async completeDueWaits() {
    const pending = new Map<string, Date>();
    for (const event of this.events) {
      if (event.eventType === 'wait_created')
        pending.set(event.correlationId, event.eventData.resumeAt);
      if (event.eventType === 'wait_completed')
        pending.delete(event.correlationId);
    }
    for (const [id, at] of pending)
      if (+at <= Date.now())
        await this.commit({
          eventType: 'wait_completed',
          correlationId: id,
          specVersion: SPEC_VERSION_CURRENT,
        });
  }

  private async receiveStepInput(value: unknown) {
    if (!this.queuedSteps)
      throw new InputRejected('Run does not use queued steps', { status: 409 });
    const result = OwnedStepResultSchema.safeParse(value);
    const status = OwnedStepStatusSchema.safeParse(value);
    if (!result.success && !status.success)
      throw new InputRejected('Invalid step input', { status: 400 });
    const input = result.success ? result.data : status.data!;
    let digest: string | undefined;
    try {
      if (result.success) digest = stepOutcomeDigest(result.data.outcome);
    } catch {
      throw new InputRejected('Invalid serialized step outcome', {
        status: 400,
      });
    }
    const prior = this.stepOutcomes.get(input.executionId);
    if (prior) {
      if (
        prior.event.correlationId !== input.stepId ||
        prior.attempt !== input.attempt
      )
        throw new InputRejected('Step outcome identity mismatch', {
          status: 400,
        });
      if (result.success && prior.digest !== digest) {
        // The owner may have timed out and superseded this execution. Its
        // eventual worker outcome must not fault the newer attempt/run.
        if (
          prior.event.eventType !== 'step_completed' ||
          this.stepStarts.get(input.stepId)?.event.eventId !== input.executionId
        )
          return { status: 'superseded' };
        throw new RunnerFault(
          'conflict',
          new Error('Step result identity reused'),
          'step_result_payload'
        );
      }
      return { status: 'accepted', eventId: prior.event.eventId };
    }
    const start = this.stepStarts.get(input.stepId);
    if (isTerminalWorkflowRunStatus(this.run.status))
      return { status: 'superseded' };
    if (!start)
      throw new InputRejected(
        'Step execution is absent from the owner snapshot',
        {
          status: 409,
          code: 'UNKNOWN_STEP_EXECUTION',
        }
      );
    if (
      start.event.eventId !== input.executionId ||
      start.attempt !== input.attempt
    ) {
      if (input.attempt < start.attempt) return { status: 'superseded' };
      throw new InputRejected(
        'Step execution does not match the owner snapshot',
        {
          status: 409,
          code: 'UNKNOWN_STEP_EXECUTION',
        }
      );
    }
    const step = this.steps.get(input.stepId);
    if (step?.status !== 'running') return { status: 'superseded' };
    if (!result.success) {
      // A redelivery cannot rerun an uncertain body. Recovery alone decides
      // whether to durably supersede this attempt and publish a new one.
      await this.advance();
      const outcome = this.stepOutcomes.get(input.executionId);
      return outcome
        ? { status: 'accepted', eventId: outcome.event.eventId }
        : { status: 'pending' };
    }
    const event = result.data.outcome;
    if (
      !isStepOutcome(event) ||
      event.correlationId !== input.stepId ||
      event.eventData.stepName !== step.stepName ||
      event.specVersion !== SPEC_VERSION_CURRENT
    )
      throw new InputRejected('Step result does not match its admission', {
        status: 400,
      });
    if (
      event.eventType === 'step_completed' &&
      event.eventData.workflowName !== this.run.workflowName
    )
      throw new InputRejected('Step result workflow mismatch', { status: 400 });
    if (event.eventType === 'step_retrying') {
      const maxRetries =
        getStepFunction(step.stepName)?.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;
      if (input.attempt >= maxRetries + 1)
        throw new RunnerFault(
          'conflict',
          new Error('Step retry budget exceeded'),
          'step_retry_budget'
        );
      const retryAt = event.eventData.retryAfter;
      if (!retryAt)
        throw new InputRejected('Missing retry deadline', { status: 400 });
      await this.armStepRecovery(+retryAt);
    }
    const committed = await this.commit(event);
    // The incoming outcome is applied before a cold owner's replay/dispatch,
    // otherwise recovery could re-run the very step that just completed.
    await this.advance();
    return { status: 'accepted', eventId: committed.event?.eventId };
  }

  private async armStepRecovery(explicitAt?: number) {
    const policy = this.queuedSteps;
    if (!policy) return;
    const now = Date.now();
    const due = [...this.steps.values()].flatMap((step) => {
      if (step.status === 'running') {
        const start = this.stepStarts.get(step.stepId);
        return start ? [+start.event.createdAt + policy.attemptTimeoutMs] : [];
      }
      if (step.status === 'pending')
        return [
          step.retryAfter ? +step.retryAfter : now + policy.attemptTimeoutMs,
        ];
      return [];
    });
    if (explicitAt !== undefined) due.push(explicitAt);
    if (!due.length) return;
    const at = Math.max(now + 1000, Math.min(...due));
    if (this.recoveryWakeAt > now && this.recoveryWakeAt <= at) return;
    await this.backend.queue(
      this.metadata.queueName,
      { runId: this.runId },
      {
        deploymentId: this.run.deploymentId,
        delaySeconds: Math.max(1, Math.ceil((at - now) / 1000)),
        idempotencyKey: `step-recovery:${this.runId}:${randomUUID()}`,
      }
    );
    this.recoveryWakeAt = at;
  }

  private async expireQueuedSteps() {
    const policy = this.queuedSteps!;
    for (const step of this.steps.values()) {
      const start = this.stepStarts.get(step.stepId);
      if (
        step.status !== 'running' ||
        !start ||
        +start.event.createdAt + policy.attemptTimeoutMs > Date.now()
      )
        continue;
      const maxRetries =
        getStepFunction(step.stepName)?.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;
      const exhausted = start.attempt >= maxRetries + 1;
      const retryAfter = new Date(Date.now() + 1000);
      if (!exhausted) await this.armStepRecovery(+retryAfter);
      const error = await dehydrateStepError(
        new Error(`Step attempt ${start.attempt} timed out`),
        this.runId,
        this.key,
        [],
        globalThis,
        (this.run.specVersion ?? 1) >= 5
      );
      await this.commit({
        eventType: exhausted ? 'step_failed' : 'step_retrying',
        correlationId: step.stepId,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          stepName: step.stepName,
          error,
          ...(!exhausted ? { retryAfter } : {}),
        },
      });
    }
  }

  private async dispatchSteps(
    steps: Array<Step & { startedAt: Date }>,
    timeoutMs: number
  ) {
    const traceCarrier = await serializeTraceCarrier();
    const messages = steps.map((step) => {
      const start = this.stepStarts.get(step.stepId);
      if (!start)
        throw new RunnerFault(
          'conflict',
          new Error('Step start missing'),
          'step_dispatch'
        );
      return {
        message: {
          runId: this.runId,
          stepId: step.stepId,
          stepName: step.stepName,
          traceCarrier,
          runContext: {
            deploymentId: this.run.deploymentId,
            specVersion: this.run.specVersion ?? 1,
            startedAt: +(this.run.startedAt ?? this.run.createdAt),
          },
          input: {
            type: 'step_execute',
            version: 1,
            executionId: start.event.eventId,
            attempt: start.attempt,
            deadline: +start.event.createdAt + timeoutMs,
            workflowName: this.run.workflowName,
            workflowStartedAt: +(this.run.startedAt ?? this.run.createdAt),
            parentSpanId: this.currentTurnId,
            executionMode:
              this.queuedSteps?.mode === 'hybrid'
                ? ('remote' as const)
                : ('queued' as const),
            step,
          },
        },
        opts: {
          deploymentId: this.run.deploymentId,
          specVersion: this.run.specVersion,
          idempotencyKey: `step-execute:${this.runId}:${start.event.eventId}`,
        },
      };
    });
    if (this.queuedSteps?.mode === 'hybrid') {
      // Direct execution can wait for a result invoke. Never await it inside the
      // serialized owner turn: that would deadlock its own result admission.
      const parentSpanId = this.currentTurnId;
      for (const { message, opts } of messages) {
        const work = this.inTurn.run(false, async () => {
          try {
            await this.observed(
              'step_dispatch',
              async () => {
                const result = await this.backend.queue(
                  this.metadata.queueName,
                  message,
                  opts
                );
                if ('error' in result && result.error)
                  throw new Error('Remote step delivery failed');
              },
              { parentSpanId, stepId: message.stepId, executionMode: 'remote' }
            );
          } catch (cause) {
            await this.enqueue('step.delivery_failed', async () => {
              // A lost HTTP reply after a committed callback is not a lost step.
              if (
                !this.stepOutcomes.has(message.input.executionId) &&
                !isTerminalWorkflowRunStatus(this.run.status)
              )
                throw cause;
            }).catch(() => {});
          } finally {
            this.workers.delete(message.stepId);
            this.signal?.();
          }
        });
        this.workers.set(message.stepId, work);
      }
      return;
    }
    try {
      await this.observed(
        'step_dispatch',
        async () => {
          const results = this.backend.queueBatch
            ? await this.backend.queueBatch(this.metadata.queueName, messages)
            : await Promise.all(
                messages.map(async ({ message, opts }) => {
                  try {
                    return await this.backend.queue(
                      this.metadata.queueName,
                      message,
                      opts
                    );
                  } catch {
                    return {
                      messageId: null,
                      error: 'Queue publication failed',
                    };
                  }
                })
              );
          if (results.length !== messages.length)
            throw new RunnerFault(
              'conflict',
              new Error('Queue batch omitted an outcome'),
              'step_dispatch_count'
            );
          if (results.some((result) => 'error' in result && result.error))
            throw new WorkflowWorldError(
              'Some admitted steps await recovery after publication failure',
              { status: 503 }
            );
        },
        { stepCount: steps.length, executionMode: 'queued' }
      );
    } catch (error) {
      if (error instanceof RunnerFault) throw error;
      // Starts are durable and the backstop was durably armed BEFORE them.
      // An ambiguous publish cannot justify rerunning the same attempt here.
      console.error('[workflow] Queued step publication awaits recovery', {
        runId: this.runId,
      });
    }
  }

  private startStep(step: Step, claimed?: Step & { startedAt: Date }) {
    this.localWorkers.add(step.stepId);
    const stepSpanId = randomUUID();
    const parentSpanId = this.currentTurnId;
    const work = Promise.resolve().then(() =>
      this.inTurn.run(false, () =>
        withScopedWorld(this.facade, async () => {
          this.observe('step', 'begin', stepSpanId, {
            parentSpanId,
            stepId: step.stepId,
            stepName: step.stepName,
          });
          try {
            const result = await executeStep({
              world: this.facade,
              workflowRunId: this.runId,
              workflowDeploymentId: this.run.deploymentId,
              workflowName: this.run.workflowName,
              workflowStartedAt: +(this.run.startedAt ?? this.run.createdAt),
              stepId: step.stepId,
              stepName: step.stepName,
              encryptionKey: this.key,
              runSpecVersion: this.run.specVersion,
              suppressOptimisticStart: true,
              authoritativeAttempt: (step.attempt ?? 0) + 1,
              ...(claimed
                ? { preclaimedStart: { owned: true as const, step: claimed } }
                : {}),
            });
            this.observe('step', 'end', stepSpanId, {
              parentSpanId,
              stepId: step.stepId,
              stepName: step.stepName,
              status: result.type === 'failed' ? 'error' : 'completed',
              outcome: result.type,
            });
            if (result.type === 'retry' || result.type === 'throttled')
              await this.backend.queue(
                this.metadata.queueName,
                { runId: this.runId },
                {
                  deploymentId: this.run.deploymentId,
                  delaySeconds: result.timeoutSeconds,
                }
              );
          } catch (cause) {
            this.observe('step', 'end', stepSpanId, {
              parentSpanId,
              stepId: step.stepId,
              stepName: step.stepName,
              status: 'error',
            });
            if (
              !this.runState ||
              !isTerminalWorkflowRunStatus(this.runState.status)
            ) {
              await this.enqueue('step.error', async () => {
                throw cause;
              }).catch(() => {});
            }
          } finally {
            this.localWorkers.delete(step.stepId);
            this.workers.delete(step.stepId);
            this.signal?.();
          }
        })
      )
    );
    this.workers.set(step.stepId, work);
  }

  private async runOwnerLoop() {
    while (!this.closing && !this.fault) {
      const item = this.pending.shift();
      if (!item) {
        if (this.runState && isTerminalWorkflowRunStatus(this.runState.status))
          break;
        const waitMs = Math.min(this.idleMs, this.deadline - Date.now() - 2000);
        if (waitMs <= 0) break;
        const woke = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            this.signal = undefined;
            resolve(false);
          }, waitMs);
          this.signal = () => {
            clearTimeout(timer);
            this.signal = undefined;
            resolve(true);
          };
        });
        if (!woke && this.workers.size === 0) break;
        continue;
      }
      await item.run.call(undefined).then(item.resolve, item.reject);
    }
    this.closing = true;
    if (
      this.workers.size > 0 &&
      this.runState &&
      !isTerminalWorkflowRunStatus(this.runState.status)
    )
      await this.fail(
        new Error('Runner deadline reached with unfinished step work')
      );
    const error =
      this.fault ??
      new WorkflowWorldError('Runner lifetime ended', { status: 503 });
    for (const item of this.pending.splice(0)) item.reject(error);
    this.session = undefined;
    try {
      await this.eventWriter?.dispose();
    } catch {
      console.error('[workflow] Could not release owner event writer', {
        runId: this.runId,
        ownerId: this.id,
      });
    }
    this.eventWriter = undefined;
    if (!this.fault || this.runState?.status === 'failed') this.retire();
  }

  private fail(cause: unknown): Promise<void> {
    this.fault ??=
      cause instanceof RunnerFault
        ? cause
        : new RunnerFault('execution', cause);
    const fault = this.fault;
    if (!this.failurePromise)
      this.failurePromise = (async () => {
        const spanId = randomUUID();
        this.observe('failure', 'begin', spanId, { errorCode: fault.kind });
        let durable =
          this.runState?.status === 'failed' &&
          (!this.eventWriter?.stage || this.failureCommitted);
        const ownerJournal =
          this.runState?.executionContext?.ownerJournalVersion === 1;
        // Preserve the legacy terminal-write path for older runs. Journal owners
        // instead use their existing writer, which rejects permanently if its
        // sequence or persistence outcome is uncertain.
        if (!ownerJournal) {
          try {
            await this.eventWriter?.dispose();
          } catch {
            // The legacy path can still attempt its native terminal write.
          }
          this.eventWriter = undefined;
        }
        if (!durable) {
          try {
            const terminal: CreateEventRequest = {
              eventType: 'run_failed',
              specVersion: SPEC_VERSION_CURRENT,
              eventData: {
                error: await dehydrateRunError(
                  this.fault,
                  this.runId,
                  this.key
                ),
                errorCode:
                  fault.kind === 'conflict'
                    ? RUN_ERROR_CODES.WORLD_CONTRACT_ERROR
                    : RUN_ERROR_CODES.RUNTIME_ERROR,
              },
            };
            // Never start a second writer after an uncertain owner prefix. A
            // healthy channel can append failure after its prefix; a failed
            // channel rejects it and exposes terminalPersisted=false below.
            const result = ownerJournal
              ? await this.eventWriter?.create(terminal, {
                  eventCount:
                    this.eventWriter.heads?.queued ?? this.events.length,
                })
              : await this.backend.events.create(this.runId, terminal);
            durable = result?.event?.eventType === 'run_failed';
            if (result?.event?.eventType === 'run_failed' && this.runState)
              Object.assign(this.runState, {
                status: 'failed',
                completedAt: result.event.createdAt,
              });
          } catch {
            durable = false;
          }
        }
        if (ownerJournal) {
          try {
            await this.eventWriter?.dispose();
          } catch {
            // Durability is determined by the canonical acknowledgement above.
          }
          this.eventWriter = undefined;
        }
        this.observe('failure', 'end', spanId, {
          status: 'error',
          errorCode: fault.kind,
          conflictReason: fault.conflictReason,
          terminalPersisted: durable,
        });
        fault.terminalPersisted = durable;
        if (!durable)
          console.error(
            '[workflow] Retained runner could not persist terminal failure',
            { runId: this.runId, ownerId: this.id }
          );
        for (const item of this.pending.splice(0)) item.reject(this.fault);
        this.signal?.();
      })();
    return this.failurePromise;
  }

  runOperation(inputId: string, operation: () => Promise<unknown>) {
    return withScopedWorld(this.facade, () =>
      this.inTurn.run(true, async () => {
        const spanId = randomUUID();
        this.currentTurnId = spanId;
        this.observe('turn', 'begin', spanId, { inputId });
        try {
          const result = await operation();
          await this.flushWriter();
          this.observe('turn', 'end', spanId, { inputId, status: 'completed' });
          return result;
        } catch (cause) {
          if (!(cause instanceof InputRejected)) await this.fail(cause);
          this.observe('turn', 'end', spanId, {
            inputId,
            status: 'error',
            errorCode: this.fault?.kind ?? 'input_rejected',
          });
          throw this.fault ?? cause;
        } finally {
          this.currentTurnId = undefined;
        }
      })
    );
  }
}

export function withRetainedRunner(
  world: World,
  prefix: QueuePrefix,
  workflowCode: string
) {
  return (legacy: LegacyHandler): Handler => {
    if (!retainedRunnerEnabled()) {
      const fallback = withRunInputs(world)(legacy);
      return (message, metadata) =>
        isOwnedStepMessage(message)
          ? executeOwnedStep(world, message, metadata)
          : fallback(message, metadata);
    }
    if (!world.capabilities?.invoke || !world.invoke)
      throw new WorkflowRuntimeError(
        'Retained runner requires an invoke-capable World'
      );
    const registries = globalSingleton(
      '@workflow/core//retainedRunners',
      1,
      () => new WeakMap<World, Map<string, RetainedRunner>>()
    );
    let owners = registries.get(world);
    if (!owners) {
      owners = new Map();
      registries.set(world, owners);
    }
    const registry = owners;
    return async (message, metadata) => {
      if (isOwnedStepMessage(message))
        return executeOwnedStep(world, message, metadata);
      if (HealthCheckPayloadSchema.safeParse(message).success)
        return legacy(message, metadata);
      const input = WorkflowInvokePayloadSchema.parse(message);
      let owner = registry.get(input.runId);
      if (!owner) {
        if (registry.size >= 64)
          throw new WorkflowWorldError('Runner capacity exceeded', {
            status: 429,
          });
        owner = new RetainedRunner(
          world,
          input.runId,
          prefix,
          workflowCode,
          metadata,
          () => registry.delete(input.runId)
        );
        registry.set(input.runId, owner);
      }
      const result = owner.submit(input, metadata);
      await owner.retain();
      return result;
    };
  };
}
