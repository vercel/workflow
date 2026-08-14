import type { Event, WorkflowRun } from '@workflow/world';
import type { DecryptionKey } from './serialization/encryption.js';
import {
  type PreparedReplayPayload,
  prepareReplayPayload,
} from './serialization/replay.js';

const WORKFLOW_INPUT_CACHE_KEY = 'workflow-input';

function isCacheablePrimitive(value: unknown): boolean {
  const type = typeof value;
  return (
    value === null ||
    (type !== 'object' && type !== 'function' && type !== 'symbol')
  );
}

/**
 * Invocation-scoped cache for replay payload hydration.
 *
 * The cache retains VM-independent decrypt/decompress output across fresh VMs.
 * Deserialization still runs against each VM's globals so object graphs and
 * Workflow objects remain realm-local. Primitive final values are safe to
 * share and skip that repeated deserialization entirely.
 */
export class ReplayPayloadCache {
  private readonly preparations = new Map<
    string,
    Uint8Array | Promise<Uint8Array> | { readonly error: unknown }
  >();
  private readonly primitiveValues = new Map<string, unknown>();
  private nextUnscannedEventIndex = 0;
  private encryptionKeyPromise?: Promise<DecryptionKey | undefined>;

  constructor(
    private encryptionKey?: DecryptionKey,
    private readonly preparer: typeof prepareReplayPayload = prepareReplayPayload
  ) {}

  static waitingForKey(
    key: Promise<DecryptionKey | undefined>,
    preparer: typeof prepareReplayPayload = prepareReplayPayload
  ): ReplayPayloadCache {
    const cache = new ReplayPayloadCache(undefined, preparer);
    cache.encryptionKeyPromise = key;
    void key.then(
      (value) => {
        cache.encryptionKey = value;
        cache.encryptionKeyPromise = undefined;
      },
      () => {}
    );
    return cache;
  }

  /** Start preparing an event as soon as its frame has been decoded. */
  observeEvent(event: Event, onPreparationStart?: () => void): void {
    switch (event.eventType) {
      case 'run_created':
        this.startPreparation(
          WORKFLOW_INPUT_CACHE_KEY,
          event.eventData.input,
          onPreparationStart
        );
        break;
      case 'run_started':
        this.startPreparation(
          WORKFLOW_INPUT_CACHE_KEY,
          event.eventData?.input,
          onPreparationStart
        );
        break;
      case 'step_completed':
        this.startPreparation(
          this.eventPayloadKey(event.eventId),
          event.eventData?.result,
          onPreparationStart
        );
        break;
      case 'step_failed':
        this.startPreparation(
          this.eventPayloadKey(event.eventId),
          event.eventData?.error,
          onPreparationStart
        );
        break;
      case 'hook_received':
        this.startPreparation(
          this.eventPayloadKey(event.eventId),
          event.eventData?.payload,
          onPreparationStart
        );
    }
  }

  /**
   * Start every preparation not already observed from the event stream.
   * Consumers await the few codecs that cannot complete synchronously.
   */
  prewarm(workflowRun: WorkflowRun, events: Event[]): void {
    this.startPreparation(WORKFLOW_INPUT_CACHE_KEY, workflowRun.input);
    for (
      let index = this.nextUnscannedEventIndex;
      index < events.length;
      index++
    ) {
      this.observeEvent(events[index]);
    }
    this.nextUnscannedEventIndex = events.length;
  }

  /** A corrected reload may insert events before the previous scan position. */
  resetScan(): void {
    this.nextUnscannedEventIndex = 0;
  }

  prepareWorkflowInput(
    workflowRun: WorkflowRun
  ): PreparedReplayPayload | Promise<PreparedReplayPayload> {
    return this.getPreparedPayload(WORKFLOW_INPUT_CACHE_KEY, workflowRun.input);
  }

  prepareEventPayload(
    eventId: string,
    value: unknown
  ): PreparedReplayPayload | Promise<PreparedReplayPayload> {
    return this.getPreparedPayload(this.eventPayloadKey(eventId), value);
  }

  getEventValue(
    eventId: string,
    serializedValue: unknown,
    hydrate: (prepared: PreparedReplayPayload) => unknown | Promise<unknown>
  ): unknown | Promise<unknown> {
    const cacheKey = this.eventPayloadKey(eventId);
    if (this.primitiveValues.has(cacheKey)) {
      return this.primitiveValues.get(cacheKey);
    }

    const prepared = this.prepareEventPayload(eventId, serializedValue);
    const hydrateAndCache = (payload: PreparedReplayPayload) => {
      const hydrated = hydrate(payload);
      return hydrated instanceof Promise
        ? hydrated.then((value) => this.cachePrimitive(cacheKey, value))
        : this.cachePrimitive(cacheKey, hydrated);
    };
    return prepared instanceof Promise
      ? prepared.then(hydrateAndCache)
      : hydrateAndCache(prepared);
  }

  private cachePrimitive(cacheKey: string, value: unknown): unknown {
    if (isCacheablePrimitive(value)) this.primitiveValues.set(cacheKey, value);
    return value;
  }

  private startPreparation(
    cacheKey: string,
    value: unknown,
    onPreparationStart?: () => void
  ): void {
    if (!(value instanceof Uint8Array) || this.preparations.has(cacheKey)) {
      return;
    }

    onPreparationStart?.();
    this.runPreparation(cacheKey, value);
  }

  private runPreparation(cacheKey: string, value: Uint8Array): void {
    try {
      const result = this.encryptionKeyPromise
        ? this.encryptionKeyPromise.then((key) => this.preparer(value, key))
        : this.preparer(value, this.encryptionKey);
      if (!(result instanceof Promise)) {
        this.preparations.set(cacheKey, result);
        return;
      }

      this.preparations.set(cacheKey, result);
      void result.then(
        (prepared) => {
          const current = this.preparations.get(cacheKey);
          if (current === result) this.preparations.set(cacheKey, prepared);
        },
        (error) => {
          const current = this.preparations.get(cacheKey);
          if (current === result) this.preparations.set(cacheKey, { error });
        }
      );
    } catch (error) {
      this.preparations.set(cacheKey, { error });
    }
  }

  private getPreparedPayload(
    cacheKey: string,
    value: unknown
  ): PreparedReplayPayload | Promise<PreparedReplayPayload> {
    if (!(value instanceof Uint8Array)) return { legacy: value };

    this.startPreparation(cacheKey, value);
    const prepared = this.preparations.get(cacheKey);
    if (!prepared) {
      throw new Error(
        `Replay payload preparation was not started: ${cacheKey}`
      );
    }

    if (prepared instanceof Uint8Array) return prepared;
    if (prepared instanceof Promise) {
      return prepared.catch((error) => {
        this.preparations.delete(cacheKey);
        throw error;
      });
    }
    this.preparations.delete(cacheKey);
    throw prepared.error;
  }

  private eventPayloadKey(eventId: string): string {
    return `event:${eventId}`;
  }
}
