import type { Event, WorkflowRun } from '@workflow/world';
import type { CryptoKey } from './encryption.js';
import {
  type PreparedReplayPayload,
  prepareReplayPayload,
  type ReplayPayloadPreparer,
} from './serialization.js';

const MAX_MEMOIZED_PRIMITIVE_LENGTH = 4096;
type ReplayPayloadField = 'result' | 'error' | 'payload';

function isMemoizablePrimitive(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'object' || type === 'function') return false;
  if (type === 'string') {
    return (value as string).length <= MAX_MEMOIZED_PRIMITIVE_LENGTH;
  }
  if (type === 'bigint') {
    return (value as bigint).toString().length <= MAX_MEMOIZED_PRIMITIVE_LENGTH;
  }
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
 * Successful prepared plaintext remains resident for the invocation lifetime.
 * Its memory cost is the sum of decrypted and decompressed payload sizes, but
 * it never crosses workflow runs or queue deliveries.
 */
export class ReplayPayloadCache {
  private readonly preparedPayloads = new Map<
    string,
    Promise<PreparedReplayPayload>
  >();
  private readonly primitiveStepResults = new Map<string, unknown>();

  constructor(
    private readonly encryptionKey: CryptoKey | undefined,
    private readonly preparer: ReplayPayloadPreparer = prepareReplayPayload
  ) {}

  /**
   * Start every missing binary preparation before workflow execution. Failures
   * are intentionally retained: the ordered event consumer must observe the
   * original rejection before that entry becomes retryable.
   */
  async prewarm(workflowRun: WorkflowRun, events: Event[]): Promise<void> {
    const preparations: Promise<PreparedReplayPayload>[] = [];
    const start = (cacheKey: string, value: unknown): void => {
      // Legacy flattened values may be mutated by devalue's unflatten and are
      // therefore prepared only by their eventual consumer, never cached.
      if (!(value instanceof Uint8Array)) return;

      // Each replay scans the full event log, so awaiting cached promises here
      // would add O(N^2) promise reactions over an N-step invocation. Only wait
      // for preparations first discovered by this prewarm pass.
      if (this.preparedPayloads.has(cacheKey)) return;
      preparations.push(this.ensurePreparation(cacheKey, value));
    };

    start(this.workflowInputKey(workflowRun.runId), workflowRun.input);
    for (const event of events) {
      switch (event.eventType) {
        case 'step_completed':
          start(
            this.eventPayloadKey(event.eventId, 'result'),
            event.eventData?.result
          );
          break;
        case 'step_failed':
          start(
            this.eventPayloadKey(event.eventId, 'error'),
            event.eventData?.error
          );
          break;
        case 'hook_received':
          start(
            this.eventPayloadKey(event.eventId, 'payload'),
            event.eventData?.payload
          );
          break;
      }
    }

    // Prewarming is speculative and must not fail replay before the matching
    // event is consumed. allSettled also attaches rejection handlers eagerly.
    await Promise.allSettled(preparations);
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
   * Objects and large strings/bigints always run `hydrate` again, producing a
   * fresh VM-specific value from the separately cached prepared payload.
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
    return this.preparer(value, this.encryptionKey);
  }

  private workflowInputKey(runId: string): string {
    return `run:${runId}:input`;
  }

  private eventPayloadKey(eventId: string, field: ReplayPayloadField): string {
    return `event:${eventId}:${field}`;
  }
}
