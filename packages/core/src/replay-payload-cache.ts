import type { Event, WorkflowRun } from '@workflow/world';
import type { DecryptionKey } from './serialization/encryption.js';
import {
  type PreparedReplayPayload,
  prepareReplayPayload,
} from './serialization/replay.js';

const WORKFLOW_INPUT = Symbol('workflow-input');
type ReplayPayloadKey = string | typeof WORKFLOW_INPUT;
type CachedPreparation = Uint8Array | Promise<Uint8Array>;

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
 *
 * Key lookup is deliberately outside this class. The runtime creates the
 * cache once the run's key has resolved, then feeds it decoded events. Most
 * Node preparation is synchronous; only codecs that are inherently async
 * leave a Promise in the cache.
 */
export class ReplayPayloadCache {
  private readonly preparations = new Map<
    ReplayPayloadKey,
    CachedPreparation
  >();
  private readonly primitiveValues = new Map<string, unknown>();

  constructor(
    private readonly encryptionKey?: DecryptionKey,
    private readonly preparer: typeof prepareReplayPayload = prepareReplayPayload
  ) {}

  /** Prepare a payload as soon as its event frame has been decoded. */
  prepareEvent(event: Event): void {
    switch (event.eventType) {
      case 'run_created':
        this.cachePayload(WORKFLOW_INPUT, event.eventData.input);
        break;
      case 'run_started':
        this.cachePayload(WORKFLOW_INPUT, event.eventData?.input);
        break;
      case 'step_completed':
        this.cachePayload(event.eventId, event.eventData?.result);
        break;
      case 'step_failed':
        this.cachePayload(event.eventId, event.eventData?.error);
        break;
      case 'hook_received':
        this.cachePayload(event.eventId, event.eventData?.payload);
    }
  }

  /** Prepare every payload not already seen through the event stream. */
  prepareAll(workflowRun: WorkflowRun, events: Event[]): void {
    this.cachePayload(WORKFLOW_INPUT, workflowRun.input);
    for (const event of events) this.prepareEvent(event);
  }

  getWorkflowInput(
    workflowRun: WorkflowRun
  ): PreparedReplayPayload | Promise<PreparedReplayPayload> {
    return this.getPayload(WORKFLOW_INPUT, workflowRun.input);
  }

  getEventValue(
    eventId: string,
    serializedValue: unknown,
    hydrate: (prepared: PreparedReplayPayload) => unknown | Promise<unknown>
  ): unknown | Promise<unknown> {
    if (this.primitiveValues.has(eventId)) {
      return this.primitiveValues.get(eventId);
    }

    const prepared = this.getPayload(eventId, serializedValue);
    const hydrateAndCache = (payload: PreparedReplayPayload) => {
      const hydrated = hydrate(payload);
      return hydrated instanceof Promise
        ? hydrated.then((value) => this.cachePrimitive(eventId, value))
        : this.cachePrimitive(eventId, hydrated);
    };
    return prepared instanceof Promise
      ? prepared.then(hydrateAndCache)
      : hydrateAndCache(prepared);
  }

  private cachePrimitive(eventId: string, value: unknown): unknown {
    if (isCacheablePrimitive(value)) {
      this.primitiveValues.set(eventId, value);
    }
    return value;
  }

  private cachePayload(cacheKey: ReplayPayloadKey, value: unknown): void {
    if (!(value instanceof Uint8Array) || this.preparations.has(cacheKey)) {
      return;
    }

    let preparation: CachedPreparation;
    try {
      preparation = this.preparer(value, this.encryptionKey);
    } catch (error) {
      // Preparation is speculative. Preserve a synchronous failure for the
      // ordered consumer without failing event loading or creating an
      // unhandled rejection.
      preparation = Promise.reject(error);
    }
    this.preparations.set(cacheKey, preparation);

    if (preparation instanceof Promise) {
      void preparation.then(
        (prepared) => {
          if (this.preparations.get(cacheKey) === preparation) {
            this.preparations.set(cacheKey, prepared);
          }
        },
        () => {}
      );
    }
  }

  private getPayload(
    cacheKey: ReplayPayloadKey,
    value: unknown
  ): PreparedReplayPayload | Promise<PreparedReplayPayload> {
    if (!(value instanceof Uint8Array)) return { legacy: value };

    this.cachePayload(cacheKey, value);
    const prepared = this.preparations.get(cacheKey);
    if (!prepared) {
      throw new Error('Replay payload preparation was not cached');
    }

    if (!(prepared instanceof Promise)) return prepared;
    return prepared.catch((error) => {
      if (this.preparations.get(cacheKey) === prepared) {
        this.preparations.delete(cacheKey);
      }
      throw error;
    });
  }
}
