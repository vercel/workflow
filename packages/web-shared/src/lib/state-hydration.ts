/**
 * Shows the actual values of frozen state stored by reference.
 *
 * A step input can be a reference to frozen state an earlier step
 * stored, and a step output only its change from that state.
 * Rebuilding them needs the run's earlier payloads. A run state hydrator reads
 * them once, only when a hydrated value needs them, and reuses them for every
 * later inspection of the run.
 */

import {
  createStateResolver,
  decodePayloadWithKey,
  deriveRunPayloadKeys,
  type StateResolver,
  stateSourceId,
} from '@workflow/core/serialization-format';
import { getWebRevivers, hydrateResourceIOAsync } from './hydration';

/** One page of a run's events, oldest first, with their data. */
export interface StateHistoryPage {
  data: readonly unknown[];
  cursor?: string | null;
  hasMore?: boolean;
}

export interface RunStateHydratorOptions {
  /** The run's `input`, as stored (`resolveData: 'all'`). */
  loadRunInput: () => Promise<unknown>;
  /**
   * A page of the run's events in ascending order, with their data, starting
   * after `cursor` (or at the start without one).
   */
  loadEvents: (cursor: string | undefined) => Promise<StateHistoryPage>;
}

export interface RunStateHydrator {
  /**
   * Like `hydrateResourceIOAsync`, but also rebuilds frozen state values,
   * reading the run's history the first time a value needs it.
   */
  hydrate<T>(resource: T, key?: Uint8Array): Promise<T>;
}

type Dict = Record<string, unknown>;

/**
 * The payload of an event that frozen state values can build on, and the
 * id later state refers to its strings by (hook payloads only).
 */
function stateSourceOf(
  event: unknown
): { value: unknown; source?: string } | undefined {
  if (event === null || typeof event !== 'object') return undefined;
  const { eventType, eventData, eventId } = event as Dict;
  if (eventData === null || typeof eventData !== 'object') return undefined;
  if (eventType === 'hook_received')
    return {
      value: (eventData as Dict).payload,
      source: stateSourceId({
        eventType,
        eventId: typeof eventId === 'string' ? eventId : undefined,
      }),
    };
  if (eventType === 'step_completed')
    return { value: (eventData as Dict).result };
  return undefined;
}

/**
 * Creates the state hydrator for one run. Keep it for as long as the run is on
 * screen and hydrate every resource of the run through it.
 */
export function createRunStateHydrator(
  options: RunStateHydratorOptions
): RunStateHydrator {
  // A different key can open different payloads, so each key gets its own.
  let state:
    | {
        key: Uint8Array | undefined;
        resolver: StateResolver;
        cursor: string | undefined;
        startedInput: boolean;
        seen: Set<string>;
        reading: Promise<void> | undefined;
      }
    | undefined;

  const stateFor = (key: Uint8Array | undefined) => {
    if (!state || state.key !== key)
      state = {
        key,
        resolver: createStateResolver(getWebRevivers()),
        cursor: undefined,
        startedInput: false,
        seen: new Set(),
        reading: undefined,
      };
    return state;
  };

  const add = async (
    resolver: StateResolver,
    value: unknown,
    key: Awaited<ReturnType<typeof deriveRunPayloadKeys>> | undefined,
    source?: string
  ) => {
    if (value === undefined || value === null) return;
    try {
      resolver.add(await decodePayloadWithKey(value, key), source);
    } catch {
      // A payload that cannot be read leaves the values built on it as
      // placeholders.
    }
  };

  /** Reads the events added since the last read, in log order. */
  const readHistory = async (current: NonNullable<typeof state>) => {
    const key = current.key
      ? await deriveRunPayloadKeys(current.key)
      : undefined;
    if (!current.startedInput) {
      await add(
        current.resolver,
        await options.loadRunInput(),
        key,
        stateSourceId('run-input')
      );
      current.startedInput = true;
    }
    for (;;) {
      const page = await options.loadEvents(current.cursor);
      for (const event of page.data) {
        // A re-read from the last cursor can repeat events.
        const id = (event as Dict | null)?.eventId;
        if (typeof id === 'string') {
          if (current.seen.has(id)) continue;
          current.seen.add(id);
        }
        const payload = stateSourceOf(event);
        if (payload)
          await add(current.resolver, payload.value, key, payload.source);
      }
      if (page.cursor) current.cursor = page.cursor;
      if (!page.hasMore || !page.cursor) return;
    }
  };

  return {
    async hydrate(resource, key) {
      const current = stateFor(key);
      const missed = current.resolver.unresolved;
      const hydrated = await hydrateResourceIOAsync(
        resource,
        key,
        current.resolver.revivers
      );
      if (current.resolver.unresolved === missed) return hydrated;
      // Concurrent inspections share one read.
      if (!current.reading)
        current.reading = readHistory(current).finally(() => {
          current.reading = undefined;
        });
      try {
        await current.reading;
      } catch {
        return hydrated;
      }
      return hydrateResourceIOAsync(resource, key, current.resolver.revivers);
    },
  };
}
