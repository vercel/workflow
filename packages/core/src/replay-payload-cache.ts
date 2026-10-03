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
  inFlightBytes?: number;
  residentBytes?: number;
}

interface PreparationJob {
  key: string;
  value: Uint8Array;
  promise: Promise<PreparedReplayPayload>;
  resolve: (value: PreparedReplayPayload) => void;
  reject: (error: unknown) => void;
  demand: boolean;
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
 * Successful prepared plaintext uses a bounded invocation-local LRU. Failed
 * speculation remains until its ordered consumer observes the original error.
 * Admission weights are serialized input bytes and prepared plaintext bytes,
 * not RSS: one oversized preparation is allowed only while otherwise idle.
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
  private readonly demanded = new Map<string, PreparationJob>();
  private readonly residents = new Map<string, number>();
  private readonly concurrency: number;
  private readonly inFlightLimit: number;
  private readonly residentLimit: number;
  private active = 0;
  private inFlightBytes = 0;
  private residentBytes = 0;
  private demandBurst = 0;
  private peakActive = 0;
  private peakInFlightBytes = 0;
  private peakResidentBytes = 0;

  constructor(
    encryptionKey: PayloadKey | undefined | Promise<PayloadKey | undefined>,
    private readonly preparer: ReplayPayloadPreparer = prepareReplayPayload,
    limits: ReplayPreparationLimits = {}
  ) {
    this.encryptionKey = Promise.resolve(encryptionKey);
    this.concurrency = limits.concurrency ?? 8;
    this.inFlightLimit = limits.inFlightBytes ?? 16 * 1024 * 1024;
    this.residentLimit = limits.residentBytes ?? 32 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.concurrency) ||
      this.concurrency < 1 ||
      !Number.isSafeInteger(this.inFlightLimit) ||
      this.inFlightLimit < 1 ||
      !Number.isSafeInteger(this.residentLimit) ||
      this.residentLimit < 0
    ) {
      throw new RangeError('Invalid replay preparation limits');
    }
  }

  getPreparationStats() {
    return {
      active: this.active,
      inFlightBytes: this.inFlightBytes,
      residentBytes: this.residentBytes,
      queued: this.speculative.size + this.demanded.size,
      peakActive: this.peakActive,
      peakInFlightBytes: this.peakInFlightBytes,
      peakResidentBytes: this.peakResidentBytes,
    };
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
        this.removeResident(cacheKey);
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
      if (demand) {
        const queued = this.speculative.get(cacheKey);
        if (queued) {
          queued.demand = true;
          this.speculative.delete(cacheKey);
          this.demanded.set(cacheKey, queued);
        }
      }
      const weight = this.residents.get(cacheKey);
      if (weight !== undefined) {
        this.residents.delete(cacheKey);
        this.residents.set(cacheKey, weight);
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
    (demand ? this.demanded : this.speculative).set(cacheKey, {
      key: cacheKey,
      value,
      promise: preparation,
      resolve,
      reject,
      demand,
    });
    this.drainPreparations();
    return preparation;
  }

  private removeResident(key: string): void {
    const weight = this.residents.get(key);
    if (weight === undefined) return;
    this.residentBytes -= weight;
    this.residents.delete(key);
  }

  private retainPrepared(
    job: PreparationJob,
    prepared: PreparedReplayPayload
  ): void {
    const data = prepared.data;
    const weight =
      data instanceof Uint8Array
        ? data.byteLength
        : typeof data === 'string'
          ? data.length * 2
          : job.value.byteLength;
    if (weight > this.residentLimit) {
      this.preparedPayloads.delete(job.key);
      return;
    }
    while (this.residentBytes + weight > this.residentLimit) {
      const oldest = this.residents.keys().next().value;
      if (oldest === undefined) break;
      this.removeResident(oldest);
      this.preparedPayloads.delete(oldest);
    }
    this.residents.set(job.key, weight);
    this.residentBytes += weight;
    this.peakResidentBytes = Math.max(
      this.peakResidentBytes,
      this.residentBytes
    );
  }

  private drainPreparations(): void {
    while (this.active < this.concurrency) {
      const speculative = this.speculative.values().next().value;
      const demand = this.demanded.values().next().value;
      // At most three demanded starts may pass a waiting speculative job.
      const job =
        demand && (!speculative || this.demandBurst < 3) ? demand : speculative;
      if (!job) break;
      // Oversized payloads run exclusively. These byte weights exclude temporary
      // decrypt/decompress buffers, parsed VM graphs and the existing event log.
      if (
        this.active > 0 &&
        this.inFlightBytes + job.value.byteLength > this.inFlightLimit
      )
        break;
      (job.demand ? this.demanded : this.speculative).delete(job.key);
      this.demandBurst = job.demand && speculative ? this.demandBurst + 1 : 0;
      this.active++;
      this.inFlightBytes += job.value.byteLength;
      this.peakActive = Math.max(this.peakActive, this.active);
      this.peakInFlightBytes = Math.max(
        this.peakInFlightBytes,
        this.inFlightBytes
      );
      void this.runPreparation(job.value)
        .then(
          (prepared) => {
            this.retainPrepared(job, prepared);
            job.resolve(prepared);
          },
          (error: unknown) => {
            // Keep the exact rejection in preparedPayloads until consumePreparation.
            job.reject(error);
          }
        )
        .finally(() => {
          this.active--;
          this.inFlightBytes -= job.value.byteLength;
          this.drainPreparations();
        });
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
