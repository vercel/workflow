import type { Event, WorkflowRun } from '@workflow/world';
import type { DecryptionKey } from './serialization/encryption.js';
import {
  type PreparedReplayPayload,
  prepareReplayPayload,
} from './serialization/replay.js';

type ReplayPayloadField = 'result' | 'error' | 'payload';

type KeyState =
  | { state: 'pending'; promise: Promise<DecryptionKey | undefined> }
  | { state: 'ready'; value: DecryptionKey | undefined }
  | { state: 'failed'; error: unknown };

type Preparation =
  | { state: 'waiting'; value: Uint8Array }
  | { state: 'ready'; value: PreparedReplayPayload }
  | { state: 'pending'; promise: Promise<PreparedReplayPayload> }
  | { state: 'failed'; error: unknown };

function isPrimitive(value: unknown): boolean {
  return value === null || !['object', 'function'].includes(typeof value);
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
  private readonly preparations = new Map<string, Preparation>();
  private readonly pendingPreparations = new Set<
    Promise<PreparedReplayPayload>
  >();
  private readonly primitiveValues = new Map<string, unknown>();
  private nextUnscannedEventIndex = 0;

  private constructor(
    private key: KeyState,
    private readonly preparer: typeof prepareReplayPayload = prepareReplayPayload
  ) {
    if (key.state === 'pending') {
      void key.promise.then(
        (value) => this.resolveKey(value),
        (error) => this.rejectKey(error)
      );
    }
  }

  static unencrypted(
    preparer: typeof prepareReplayPayload = prepareReplayPayload
  ): ReplayPayloadCache {
    return new ReplayPayloadCache(
      { state: 'ready', value: undefined },
      preparer
    );
  }

  static withKey(
    key: DecryptionKey,
    preparer: typeof prepareReplayPayload = prepareReplayPayload
  ): ReplayPayloadCache {
    return new ReplayPayloadCache({ state: 'ready', value: key }, preparer);
  }

  static waitingForKey(
    key: Promise<DecryptionKey | undefined>,
    preparer: typeof prepareReplayPayload = prepareReplayPayload
  ): ReplayPayloadCache {
    return new ReplayPayloadCache({ state: 'pending', promise: key }, preparer);
  }

  /** Start preparing an event as soon as its frame has been decoded. */
  observeEvent(event: Event, onPreparationStart?: () => void): void {
    switch (event.eventType) {
      case 'run_created':
        this.start(
          this.workflowInputKey(event.runId),
          event.eventData.input,
          onPreparationStart
        );
        break;
      case 'run_started':
        this.start(
          this.workflowInputKey(event.runId),
          event.eventData?.input,
          onPreparationStart
        );
        break;
      case 'step_completed':
        this.start(
          this.eventPayloadKey(event.eventId, 'result'),
          event.eventData?.result,
          onPreparationStart
        );
        break;
      case 'step_failed':
        this.start(
          this.eventPayloadKey(event.eventId, 'error'),
          event.eventData?.error,
          onPreparationStart
        );
        break;
      case 'hook_received':
        this.start(
          this.eventPayloadKey(event.eventId, 'payload'),
          event.eventData?.payload,
          onPreparationStart
        );
    }
  }

  /**
   * Start every preparation not already observed from the event stream.
   * Returns a Promise only when a sealed or portable codec is still running.
   */
  prewarm(workflowRun: WorkflowRun, events: Event[]): void | Promise<void> {
    this.start(
      this.workflowInputKey(workflowRun.runId),
      workflowRun.input
    );
    for (
      let index = this.nextUnscannedEventIndex;
      index < events.length;
      index++
    ) {
      this.observeEvent(events[index]);
    }
    this.nextUnscannedEventIndex = events.length;
    return this.waitForPending();
  }

  /** A corrected reload may insert events before the previous scan position. */
  resetScan(): void {
    this.nextUnscannedEventIndex = 0;
  }

  prepareWorkflowInput(
    workflowRun: WorkflowRun
  ): PreparedReplayPayload | Promise<PreparedReplayPayload> {
    return this.consume(
      this.workflowInputKey(workflowRun.runId),
      workflowRun.input
    );
  }

  prepareEventPayload(
    eventId: string,
    field: ReplayPayloadField,
    value: unknown
  ): PreparedReplayPayload | Promise<PreparedReplayPayload> {
    return this.consume(this.eventPayloadKey(eventId, field), value);
  }

  getEventValue(
    eventId: string,
    field: ReplayPayloadField,
    serializedValue: unknown,
    hydrate: (prepared: PreparedReplayPayload) => unknown | Promise<unknown>
  ): unknown | Promise<unknown> {
    const cacheKey = this.eventPayloadKey(eventId, field);
    if (this.primitiveValues.has(cacheKey)) {
      return this.primitiveValues.get(cacheKey);
    }

    const prepared = this.prepareEventPayload(
      eventId,
      field,
      serializedValue
    );
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
    if (isPrimitive(value)) this.primitiveValues.set(cacheKey, value);
    return value;
  }

  private start(
    cacheKey: string,
    value: unknown,
    onPreparationStart?: () => void
  ): void {
    if (!(value instanceof Uint8Array) || this.preparations.has(cacheKey)) {
      return;
    }

    onPreparationStart?.();
    switch (this.key.state) {
      case 'pending':
        this.preparations.set(cacheKey, { state: 'waiting', value });
        break;
      case 'ready':
        this.prepare(cacheKey, value, this.key.value);
        break;
      case 'failed':
        this.preparations.set(cacheKey, {
          state: 'failed',
          error: this.key.error,
        });
        break;
    }
  }

  private prepare(
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

      this.preparations.set(cacheKey, { state: 'pending', promise: result });
      this.pendingPreparations.add(result);
      void result.then(
        (prepared) => {
          this.pendingPreparations.delete(result);
          const current = this.preparations.get(cacheKey);
          if (current?.state === 'pending' && current.promise === result) {
            this.preparations.set(cacheKey, {
              state: 'ready',
              value: prepared,
            });
          }
        },
        (error) => {
          this.pendingPreparations.delete(result);
          const current = this.preparations.get(cacheKey);
          if (current?.state === 'pending' && current.promise === result) {
            this.preparations.set(cacheKey, { state: 'failed', error });
          }
        }
      );
    } catch (error) {
      this.preparations.set(cacheKey, { state: 'failed', error });
    }
  }

  private consume(
    cacheKey: string,
    value: unknown
  ): PreparedReplayPayload | Promise<PreparedReplayPayload> {
    if (!(value instanceof Uint8Array)) return { legacy: value };

    this.start(cacheKey, value);
    const preparation = this.preparations.get(cacheKey);
    if (!preparation) {
      throw new Error(`Replay payload preparation was not started: ${cacheKey}`);
    }

    switch (preparation.state) {
      case 'ready':
        return preparation.value;
      case 'pending':
        return preparation.promise;
      case 'failed':
        this.preparations.delete(cacheKey);
        throw preparation.error;
      case 'waiting':
        if (this.key.state !== 'pending') {
          throw new Error(`Replay payload key was not resolved: ${cacheKey}`);
        }
        return this.key.promise.then(() => this.consume(cacheKey, value));
    }
  }

  private waitForPending(): void | Promise<void> {
    if (
      this.key.state === 'pending' &&
      [...this.preparations.values()].some(
        (preparation) => preparation.state === 'waiting'
      )
    ) {
      return this.key.promise.then(() => this.waitForPending());
    }
    if (this.pendingPreparations.size === 0) return;
    return Promise.allSettled([...this.pendingPreparations]).then(() => {});
  }

  private resolveKey(value: DecryptionKey | undefined): void {
    if (this.key.state !== 'pending') return;
    this.key = { state: 'ready', value };
    for (const [cacheKey, preparation] of this.preparations) {
      if (preparation.state === 'waiting') {
        this.prepare(cacheKey, preparation.value, value);
      }
    }
  }

  private rejectKey(error: unknown): void {
    if (this.key.state !== 'pending') return;
    this.key = { state: 'failed', error };
    for (const [cacheKey, preparation] of this.preparations) {
      if (preparation.state === 'waiting') {
        this.preparations.set(cacheKey, { state: 'failed', error });
      }
    }
  }

  private workflowInputKey(runId: string): string {
    return `run:${runId}:input`;
  }

  private eventPayloadKey(eventId: string, field: ReplayPayloadField): string {
    return `event:${eventId}:${field}`;
  }
}
