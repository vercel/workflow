import type { Event, WorkflowRun } from '@workflow/world';
import type { PayloadKey } from './serialization/encryption.js';
import {
  type PreparedReplayPayload,
  prepareReplayPayload,
  type ReplayPayloadPreparer,
} from './serialization.js';

type ReplayPayloadField = 'result' | 'error' | 'payload';

export interface ReplayPreparationLimits {
  concurrency?: number;
}

interface PreparationJob {
  value: Uint8Array;
  resolve: (value: PreparedReplayPayload) => void;
  reject: (error: unknown) => void;
}

function isMemoizablePrimitive(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'object' || type === 'function') return false;
  return true;
}

/**
 * Invocation-scoped cache for replay payload hydration.
 *
 * A workflow invocation may replay the same event log through several fresh
 * VMs. This cache keeps the VM-independent decrypt/decompress result across
 * those replays. Deserialization still runs against each VM's globals so every
 * replay receives fresh object graphs and correctly revived Workflow objects.
 *
 * Successful preparations remain available for the invocation. Speculative
 * preparation has a concurrency limit; a demanded queued payload starts
 * immediately. Failed speculation remains until its ordered consumer observes
 * the original error.
 */
export class ReplayPayloadCache {
  private readonly preparedPayloads = new Map<
    string,
    Promise<PreparedReplayPayload>
  >();
  private readonly primitiveStepResults = new Map<string, unknown>();
  private readonly encryptionKey: Promise<PayloadKey | undefined>;
  private nextUnscannedEventIndex = 0;
  private readonly speculative = new Map<string, PreparationJob>();
  private readonly concurrency: number;
  private activeSpeculative = 0;

  constructor(
    encryptionKey: PayloadKey | undefined | Promise<PayloadKey | undefined>,
    private readonly preparer: ReplayPayloadPreparer = prepareReplayPayload,
    limits: ReplayPreparationLimits = {}
  ) {
    this.encryptionKey = Promise.resolve(encryptionKey);
    this.concurrency = limits.concurrency ?? 8;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new RangeError('Invalid replay preparation concurrency');
    }
  }

  /** Start preparing an event payload as soon as its frame is decoded. */
  prepareEvent(event: Event): void {
    const preparation = this.prepareEventIfMissing(event);
    // Streaming preparation is speculative. Its ordered consumer observes the
    // original rejection and makes that cache entry retryable.
    void preparation?.catch(() => {});
  }

  /**
   * Start every missing binary preparation before workflow execution. Failures
   * are intentionally retained: the ordered event consumer must observe the
   * original rejection before that entry becomes retryable.
   */
  async prewarm(workflowRun: WorkflowRun, events: Event[]): Promise<void> {
    const preparations: Promise<PreparedReplayPayload>[] = [];
    const workflowInput = this.startPreparation(
      this.workflowInputKey(workflowRun.runId),
      workflowRun.input
    );
    if (workflowInput) preparations.push(workflowInput);
    for (
      let index = this.nextUnscannedEventIndex;
      index < events.length;
      index++
    ) {
      const event = events[index];
      const preparation = this.prepareEventIfMissing(event);
      if (preparation) preparations.push(preparation);
    }
    this.nextUnscannedEventIndex = events.length;

    // Prewarming is speculative and must not fail replay before the matching
    // event is consumed. allSettled also attaches rejection handlers eagerly.
    await Promise.allSettled(preparations);
  }

  /** Rescan the next event log after an authoritative replacement. */
  resetScan(): void {
    this.nextUnscannedEventIndex = 0;
  }

  /** Return the workflow input after shared host-side preparation. */
  prepareWorkflowInput(
    workflowRun: WorkflowRun
  ): Promise<PreparedReplayPayload> {
    return this.consumePreparation(
      this.workflowInputKey(workflowRun.runId),
      workflowRun.input
    );
  }

  /**
   * Return an event payload after shared host-side preparation. A rejected
   * preparation is evicted only after this ordered consumer requests it, so a
   * later replay can retry without hiding the original failure.
   */
  prepareEventPayload(
    eventId: string,
    field: ReplayPayloadField,
    value: unknown
  ): Promise<PreparedReplayPayload> {
    return this.consumePreparation(this.eventPayloadKey(eventId, field), value);
  }

  /**
   * Reuse final step values only when sharing them across VMs is unobservable.
   * Objects always run `hydrate` again to produce a fresh VM-specific value;
   * every primitive is safe to reuse directly.
   */
  async getStepResult(
    eventId: string,
    hydrate: () => Promise<unknown>
  ): Promise<unknown> {
    if (this.primitiveStepResults.has(eventId)) {
      return this.primitiveStepResults.get(eventId);
    }

    const value = await hydrate();
    if (isMemoizablePrimitive(value)) {
      this.primitiveStepResults.set(eventId, value);
    }
    return value;
  }

  /**
   * Consumer-facing lookup. Binary payloads share preparation; legacy values
   * bypass the cache because their flattened representation may be mutated.
   */
  private consumePreparation(
    cacheKey: string,
    value: unknown
  ): Promise<PreparedReplayPayload> {
    if (!(value instanceof Uint8Array)) return this.runPreparation(value);

    const preparation = this.ensurePreparation(cacheKey, value, true);
    void preparation.catch(() => {
      if (this.preparedPayloads.get(cacheKey) === preparation) {
        this.preparedPayloads.delete(cacheKey);
      }
    });
    return preparation;
  }

  /** Start preparation once and share the exact in-flight promise. */
  private ensurePreparation(
    cacheKey: string,
    value: Uint8Array,
    demand = false
  ): Promise<PreparedReplayPayload> {
    const cached = this.preparedPayloads.get(cacheKey);
    if (cached) {
      const queued = demand ? this.speculative.get(cacheKey) : undefined;
      if (queued) {
        this.speculative.delete(cacheKey);
        this.runJob(queued, false);
      }
      return cached;
    }

    let resolve!: PreparationJob['resolve'];
    let reject!: PreparationJob['reject'];
    const preparation = new Promise<PreparedReplayPayload>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Register before starting work, including synchronous/reentrant preparers.
    this.preparedPayloads.set(cacheKey, preparation);
    const job = { value, resolve, reject };
    if (demand) {
      this.runJob(job, false);
    } else {
      this.speculative.set(cacheKey, job);
      this.drainPreparations();
    }
    return preparation;
  }

  private runJob(job: PreparationJob, speculative: boolean): void {
    if (speculative) this.activeSpeculative++;
    void this.runPreparation(job.value)
      .then(job.resolve, job.reject)
      .finally(() => {
        if (speculative) this.activeSpeculative--;
        this.drainPreparations();
      });
  }

  private drainPreparations(): void {
    while (this.activeSpeculative < this.concurrency) {
      const entry = this.speculative.entries().next().value;
      if (!entry) break;
      const [key, job] = entry;
      this.speculative.delete(key);
      this.runJob(job, true);
    }
  }

  /** Normalize synchronous and asynchronous preparers to one promise contract. */
  private async runPreparation(value: unknown): Promise<PreparedReplayPayload> {
    return this.preparer(value, await this.encryptionKey);
  }

  /** Start one event's binary payload unless another path already did. */
  private prepareEventIfMissing(
    event: Event
  ): Promise<PreparedReplayPayload> | undefined {
    let field: ReplayPayloadField;
    let value: unknown;
    switch (event.eventType) {
      case 'run_created':
        return this.startPreparation(
          this.workflowInputKey(event.runId),
          event.eventData.input
        );
      case 'run_started':
        return this.startPreparation(
          this.workflowInputKey(event.runId),
          event.eventData?.input
        );
      case 'step_completed':
        field = 'result';
        value = event.eventData?.result;
        break;
      case 'step_failed':
        field = 'error';
        value = event.eventData?.error;
        break;
      case 'hook_received':
        field = 'payload';
        value = event.eventData?.payload;
        break;
      default:
        return undefined;
    }
    return this.startPreparation(
      this.eventPayloadKey(event.eventId, field),
      value
    );
  }

  private startPreparation(
    cacheKey: string,
    value: unknown
  ): Promise<PreparedReplayPayload> | undefined {
    if (!(value instanceof Uint8Array) || this.preparedPayloads.has(cacheKey)) {
      return undefined;
    }
    return this.ensurePreparation(cacheKey, value);
  }

  private workflowInputKey(runId: string): string {
    return `run:${runId}:input`;
  }

  private eventPayloadKey(eventId: string, field: ReplayPayloadField): string {
    return `event:${eventId}:${field}`;
  }
}
