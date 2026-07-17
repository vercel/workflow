import type { Event, WorkflowRun } from '@workflow/world';
import type { CryptoKey } from './encryption.js';
import {
  type PreparedReplayPayload,
  prepareReplayPayload,
  type ReplayPayloadPreparer,
} from './serialization.js';

/** Maximum string/bigint length retained in the final primitive-value cache. */
export const MAX_MEMOIZED_PRIMITIVE_LENGTH = 4096;

type ReplayPayloadField = 'result' | 'error' | 'payload';

/**
 * Invocation-scoped replay cache. Prepared serialized bytes can be shared
 * across fresh workflow VMs, while final values are shared only when they are
 * immutable primitives. Prepared plaintext is intentionally retained for the
 * invocation lifetime to avoid replay-length-dependent preparation work; its
 * memory cost is the sum of the decrypted and decompressed payload sizes.
 */
export interface ReplayHydrationCache {
  readonly preparedPayloads: Map<string, Promise<PreparedReplayPayload>>;
  readonly primitiveValues: Map<string, unknown>;
}

export function createReplayHydrationCache(): ReplayHydrationCache {
  return {
    preparedPayloads: new Map(),
    primitiveValues: new Map(),
  };
}

export function workflowInputPayloadKey(runId: string): string {
  return `run:${runId}:input`;
}

export function eventPayloadKey(
  eventId: string,
  field: ReplayPayloadField
): string {
  return `event:${eventId}:${field}`;
}

function runReplayPayloadPreparer(
  value: unknown,
  encryptionKey: CryptoKey | undefined,
  preparer: ReplayPayloadPreparer
): Promise<PreparedReplayPayload> {
  try {
    return Promise.resolve(preparer(value, encryptionKey));
  } catch (error) {
    return Promise.reject(error);
  }
}

function getOrStartCachedPreparation(
  cache: ReplayHydrationCache,
  cacheKey: string,
  value: Uint8Array,
  encryptionKey: CryptoKey | undefined,
  preparer: ReplayPayloadPreparer
): Promise<PreparedReplayPayload> {
  const cached = cache.preparedPayloads.get(cacheKey);
  if (cached) return cached;

  const preparation = runReplayPayloadPreparer(value, encryptionKey, preparer);
  cache.preparedPayloads.set(cacheKey, preparation);
  return preparation;
}

/**
 * Return the shared preparation promise for a replay payload. A failed
 * speculative preparation stays cached until this ordered consumer observes
 * it, then is evicted so a later replay can retry. Legacy non-binary values
 * bypass the cache because devalue's unflatten operation may mutate its parsed
 * input representation.
 */
export function getOrPrepareReplayPayload(
  cache: ReplayHydrationCache | undefined,
  cacheKey: string,
  value: unknown,
  encryptionKey: CryptoKey | undefined,
  preparer: ReplayPayloadPreparer = prepareReplayPayload
): Promise<PreparedReplayPayload> {
  if (!cache || !(value instanceof Uint8Array)) {
    return runReplayPayloadPreparer(value, encryptionKey, preparer);
  }

  const preparation = getOrStartCachedPreparation(
    cache,
    cacheKey,
    value,
    encryptionKey,
    preparer
  );
  void preparation.catch(() => {
    if (cache.preparedPayloads.get(cacheKey) === preparation) {
      cache.preparedPayloads.delete(cacheKey);
    }
  });
  return preparation;
}

/**
 * Start all VM-independent replay payload preparation concurrently. Consumers
 * still deserialize and resolve through the serial promiseQueue, so completion
 * order here is not observable by workflow code.
 */
export async function prewarmReplayPayloads(
  cache: ReplayHydrationCache | undefined,
  workflowRun: WorkflowRun,
  events: Event[],
  encryptionKey: CryptoKey | undefined,
  preparer: ReplayPayloadPreparer = prepareReplayPayload
): Promise<void> {
  if (!cache) return;

  const preparations: Promise<PreparedReplayPayload>[] = [];
  const prewarm = (cacheKey: string, value: unknown): void => {
    if (!(value instanceof Uint8Array)) return;
    preparations.push(
      getOrStartCachedPreparation(
        cache,
        cacheKey,
        value,
        encryptionKey,
        preparer
      )
    );
  };

  prewarm(workflowInputPayloadKey(workflowRun.runId), workflowRun.input);

  for (const event of events) {
    switch (event.eventType) {
      case 'step_completed':
        prewarm(
          eventPayloadKey(event.eventId, 'result'),
          event.eventData?.result
        );
        break;
      case 'step_failed':
        prewarm(
          eventPayloadKey(event.eventId, 'error'),
          event.eventData?.error
        );
        break;
      case 'hook_received':
        prewarm(
          eventPayloadKey(event.eventId, 'payload'),
          event.eventData?.payload
        );
        break;
    }
  }

  // Preparation failures remain observable at the exact consumer that reads
  // the payload. Prewarming itself must not fail a replay early.
  await Promise.all(
    preparations.map((pending) => pending.catch(() => undefined))
  );
}

export function isMemoizablePrimitive(value: unknown): boolean {
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
 * Memoize only final primitive step values. Object graphs must be revived
 * afresh for every VM, even though their prepared serialized bytes are cached.
 */
export async function getOrHydrateStepReturnValue(
  cache: ReplayHydrationCache | undefined,
  eventId: string | undefined,
  hydrate: () => Promise<unknown>
): Promise<unknown> {
  if (!cache || eventId === undefined) return hydrate();
  if (cache.primitiveValues.has(eventId)) {
    return cache.primitiveValues.get(eventId);
  }

  const value = await hydrate();
  if (isMemoizablePrimitive(value)) {
    cache.primitiveValues.set(eventId, value);
  }
  return value;
}
