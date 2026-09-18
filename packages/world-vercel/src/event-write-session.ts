import type {
  CreateEventParams,
  CreateEventRequest,
  EventResult,
  EventWriteSession,
} from '@workflow/world';
import { BufferedEventWriter } from './buffered-event-writer.js';
import { createWorkflowRunEvent } from './events.js';
import type { APIConfig } from './utils.js';
import { isWsEventsTransportEnabled } from './ws-transport-enabled.js';

/** An owner loop holds this lease across inputs, asynchronous steps and idle waits. */
export function createEventWriteSession(
  runId: string,
  config?: APIConfig
): EventWriteSession {
  let disposed = false;
  // Handle rejection immediately even when snapshot loading fails before a write.
  const opened = (
    isWsEventsTransportEnabled()
      ? import('./ws-transport.js').then(({ openWsChannel }) =>
          openWsChannel(runId, config)
        )
      : Promise.resolve(undefined)
  ).then(
    (lease) => ({ lease, error: undefined, failed: false }),
    (error: unknown) => ({ lease: undefined, error, failed: true })
  );
  let disposal: Promise<void> | undefined;
  const write = async (
    event: CreateEventRequest,
    params?: CreateEventParams,
    onSent?: () => void
  ): Promise<EventResult> => {
    if (disposed) throw new Error('Event writer is disposed');
    const { lease, error, failed } = await opened;
    if (failed) throw error;
    if (process.env.WORKFLOW_EVENTS_TRANSPORT === 'eventsync' && !lease)
      throw new Error('Canonical eventsync requires an active event channel');
    await lease?.ready();
    if (disposed) throw new Error('Event writer is disposed');
    return createWorkflowRunEvent(
      runId,
      event,
      {
        ...params,
        skipPreload: true,
        preloadEvents: undefined,
      },
      lease
        ? {
            ...config,
            requireWsEvents: true,
            onEventSent: onSent,
            failStopEventWrites:
              process.env.WORKFLOW_EVENTS_TRANSPORT === 'eventsync',
          }
        : config
    );
  };
  const dispose = () => {
    disposed = true;
    disposal ??= opened.then(({ lease }) => {
      lease?.();
    });
    return disposal;
  };
  return process.env.WORKFLOW_EVENTS_TRANSPORT === 'eventsync'
    ? new BufferedEventWriter(runId, write, dispose)
    : { create: write, dispose };
}
