import type { Event, WorkflowRun } from '@workflow/world';
import type { PayloadKey } from './serialization/encryption.js';
import {
  type PreparedReplayPayload,
  prepareReplayPayload,
  type ReplayPayloadPreparer,
} from './serialization.js';

type ReplayPayloadField = 'result' | 'error' | 'payload';

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
 * Successful prepared plaintext and memoized primitive step results remain
 * resident for the invocation lifetime. Their memory never crosses workflow
 * runs or queue deliveries.
 */
export class ReplayPayloadCache {
  private readonly preparedPayloads = new Map<
    string,
    Promise<PreparedReplayPayload>
  >();
  private readonly primitiveStepResults = new Map<string, unknown>();
  private readonly encryptionKey: Promise<PayloadKey | undefined>;
  private nextUnscannedEventIndex = 0;

  constructor(
    encryptionKey: PayloadKey | undefined | Promise<PayloadKey | undefined>,
    private readonly preparer: ReplayPayloadPreparer = prepareReplayPayload
  ) {
    this.encryptionKey = Promise.resolve(encryptionKey);
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

    const preparation = this.ensurePreparation(cacheKey, value);
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
    value: Uint8Array
  ): Promise<PreparedReplayPayload> {
    const cached = this.preparedPayloads.get(cacheKey);
    if (cached) return cached;

    const preparation = this.runPreparation(value);
    this.preparedPayloads.set(cacheKey, preparation);
    return preparation;
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
