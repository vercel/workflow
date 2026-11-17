'use client';

import { type Event, getEventDataRefFields } from '@workflow/world';
import { useEffect, useRef, useState } from 'react';

/**
 * Loads one event's full eventData. Loaders that take the second argument can
 * abort their request when the result is no longer wanted; loaders that
 * ignore it are still guarded, because a superseded result is never applied.
 */
export type LoadEventData = (
  event: Event,
  options?: { signal?: AbortSignal }
) => Promise<unknown | null>;

export interface UseEventPayloadOptions {
  event: Event;
  onLoadEventData?: LoadEventData;
  /** Set once Decrypt is clicked; a change reloads the payload decrypted. */
  encryptionKey?: Uint8Array;
  /**
   * Whether to load now. The sidebar holds off until its card is first
   * expanded and then keeps it true; the Events tab loads on mount.
   */
  enabled?: boolean;
  /** A payload already loaded for this event, for example from a cache. */
  initialData?: unknown | null;
  /** Called with each payload this hook loads, for the caller's cache. */
  onLoaded?: (eventId: string, data: unknown) => void;
}

export interface EventPayloadState {
  /** The full payload, or null while it is unknown. */
  data: unknown | null;
  /** A load is in flight. `data` may still hold the previous payload. */
  loading: boolean;
  /** Why the latest load failed. */
  error: string | null;
}

interface InternalState extends EventPayloadState {
  eventId: string;
}

/**
 * Whether the eventData that came with the event is the whole payload. List
 * endpoints strip the ref fields (input, result, error, payload), so inline
 * data is complete only when the type has none of them or nothing can load
 * the full event.
 */
function hasCompleteInlineData(event: Event, canLoad: boolean): boolean {
  return (
    'eventData' in event &&
    event.eventData != null &&
    (!canLoad || getEventDataRefFields(event.eventType).length === 0)
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The load state of one event's payload, shared by the sidebar's event cards
 * and the Events tab's details panel.
 *
 * Loads when enabled unless a complete payload is already at hand, and loads
 * again whenever the encryption key changes so a payload fetched sealed is
 * shown decrypted. Each load is aborted when the event, the key or `enabled`
 * changes or the component unmounts, and an aborted load's result or error is
 * dropped, so an older load that settles late never overwrites a newer one.
 * While a reload is in flight the previous payload stays in `data`.
 */
export function useEventPayload({
  event,
  onLoadEventData,
  encryptionKey,
  enabled = true,
  initialData = null,
  onLoaded,
}: UseEventPayloadOptions): EventPayloadState {
  const canLoad = !!onLoadEventData;
  const initialState = (): InternalState => {
    const data =
      initialData ??
      (hasCompleteInlineData(event, canLoad) ? event.eventData : null);
    return {
      eventId: event.eventId,
      data,
      // Matches the load effect's decision, so the first paint already shows
      // the skeleton instead of an empty section.
      loading:
        enabled && canLoad && (encryptionKey !== undefined || data === null),
      error: null,
    };
  };
  const [stored, setState] = useState(initialState);
  let state = stored;
  if (state.eventId !== event.eventId) {
    state = initialState();
    setState(state);
  }

  // The effect reads these through a ref so a new loader or event object
  // with the same eventId (a parent re-render) doesn't start another load.
  const latest = useRef({ event, onLoadEventData, onLoaded, data: state.data });
  latest.current = { event, onLoadEventData, onLoaded, data: state.data };

  const eventId = event.eventId;
  useEffect(() => {
    const { event, onLoadEventData: load } = latest.current;
    // Nothing to fetch: loading is off, or the payload is complete and there
    // is no key to decrypt it with. Clear the flag a cancelled load left.
    if (
      !enabled ||
      !canLoad ||
      !load ||
      (encryptionKey === undefined && latest.current.data !== null)
    ) {
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return;
    }

    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    load(event, { signal: controller.signal }).then(
      (loaded) => {
        if (controller.signal.aborted) return;
        if (loaded != null) latest.current.onLoaded?.(eventId, loaded);
        setState((s) => ({ ...s, data: loaded ?? s.data, loading: false }));
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error: errorMessage(err) }));
      }
    );
    return () => controller.abort();
  }, [eventId, encryptionKey, enabled, canLoad]);

  return { data: state.data, loading: state.loading, error: state.error };
}
