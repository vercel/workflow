import type { Event, WorkflowRun } from '@workflow/world';
import type { DecryptionKey } from './serialization/encryption.js';
import {
  type PreparedReplayPayload,
  prepareReplayPayload,
} from './serialization/replay.js';

const WORKFLOW_INPUT_CACHE_KEY = 'workflow-input';

type KeyState =
  | { state: 'loading'; promise: Promise<DecryptionKey | undefined> }
  | { state: 'ready'; value: DecryptionKey | undefined }
  | { state: 'failed'; error: unknown };

type Preparation =
  | { state: 'waitingForKey'; value: Uint8Array }
  | { state: 'ready'; value: PreparedReplayPayload }
  | { state: 'preparing'; promise: Promise<PreparedReplayPayload> }
  | { state: 'failed'; error: unknown };

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
  private key: KeyState;
  private readonly preparations = new Map<string, Preparation>();
  private readonly primitiveValues = new Map<string, unknown>();
  private nextUnscannedEventIndex = 0;

  constructor(
    key?: DecryptionKey,
    private readonly preparer: typeof prepareReplayPayload = prepareReplayPayload
  ) {
    this.key = { state: 'ready', value: key };
  }

  static waitingForKey(
    key: Promise<DecryptionKey | undefined>,
    preparer: typeof prepareReplayPayload = prepareReplayPayload
  ): ReplayPayloadCache {
    const cache = new ReplayPayloadCache(undefined, preparer);
    cache.key = { state: 'loading', promise: key };
    void key.then(
      (value) => cache.resolveKey(value),
      (error) => cache.rejectKey(error)
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
    switch (this.key.state) {
      case 'loading':
        this.preparations.set(cacheKey, { state: 'waitingForKey', value });
        break;
      case 'ready':
        this.runPreparation(cacheKey, value, this.key.value);
        break;
      case 'failed':
        this.preparations.set(cacheKey, {
          state: 'failed',
          error: this.key.error,
        });
        break;
    }
  }

  private runPreparation(
    cacheKey: string,
    value: Uint8Array,
    key: DecryptionKey | undefined
  ): void {
    try {
      const result = this.preparer(value, key);
      if (!(result instanceof Promise)) {
        this.preparations.set(cacheKey, { state: 'ready', value: result });
        return;
      }

      this.preparations.set(cacheKey, { state: 'preparing', promise: result });
      void result.then(
        (prepared) => {
          const current = this.preparations.get(cacheKey);
          if (current?.state === 'preparing' && current.promise === result) {
            this.preparations.set(cacheKey, {
              state: 'ready',
              value: prepared,
            });
          }
        },
        (error) => {
          const current = this.preparations.get(cacheKey);
          if (current?.state === 'preparing' && current.promise === result) {
            this.preparations.set(cacheKey, { state: 'failed', error });
          }
        }
      );
    } catch (error) {
      this.preparations.set(cacheKey, { state: 'failed', error });
    }
  }

  private getPreparedPayload(
    cacheKey: string,
    value: unknown
  ): PreparedReplayPayload | Promise<PreparedReplayPayload> {
    if (!(value instanceof Uint8Array)) return { legacy: value };

    this.startPreparation(cacheKey, value);
    const preparation = this.preparations.get(cacheKey);
    if (!preparation) {
      throw new Error(
        `Replay payload preparation was not started: ${cacheKey}`
      );
    }

    switch (preparation.state) {
      case 'ready':
        return preparation.value;
      case 'preparing':
        return preparation.promise.catch((error) => {
          const current = this.preparations.get(cacheKey);
          if (
            current?.state === 'failed' ||
            (current?.state === 'preparing' &&
              current.promise === preparation.promise)
          ) {
            this.preparations.delete(cacheKey);
          }
          throw error;
        });
      case 'failed':
        this.preparations.delete(cacheKey);
        throw preparation.error;
      case 'waitingForKey':
        if (this.key.state !== 'loading') {
          throw new Error(`Replay payload key was not resolved: ${cacheKey}`);
        }
        return this.key.promise.then(() =>
          this.getPreparedPayload(cacheKey, value)
        );
    }
  }

  private resolveKey(value: DecryptionKey | undefined): void {
    if (this.key.state !== 'loading') return;
    this.key = { state: 'ready', value };
    for (const [cacheKey, preparation] of this.preparations) {
      if (preparation.state === 'waitingForKey') {
        this.runPreparation(cacheKey, preparation.value, value);
      }
    }
  }

  private rejectKey(error: unknown): void {
    if (this.key.state !== 'loading') return;
    this.key = { state: 'failed', error };
    for (const [cacheKey, preparation] of this.preparations) {
      if (preparation.state === 'waitingForKey') {
        this.preparations.set(cacheKey, { state: 'failed', error });
      }
    }
  }

  private eventPayloadKey(eventId: string): string {
    return `event:${eventId}`;
  }
}
