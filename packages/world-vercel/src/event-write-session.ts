import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
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
  const observations = channel('workflow.eventsync');
  const spanId = randomUUID();
  const started = performance.now();
  const observeReady = (event: 'begin' | 'end', status?: string) => {
    if (
      process.env.WORKFLOW_EVENTS_TRANSPORT === 'eventsync' &&
      observations.hasSubscribers
    )
      observations.publish({
        version: 1,
        runId,
        spanId,
        phase: 'writer_ready',
        event,
        at: Date.now(),
        status,
        elapsedMs: performance.now() - started,
      });
  };
  observeReady('begin');
  // Handle rejection immediately even when snapshot loading fails before a write.
  const opened = (
    isWsEventsTransportEnabled()
      ? import('./ws-transport.js').then(({ openWsChannel }) =>
          openWsChannel(runId, config)
        )
      : Promise.resolve(undefined)
  ).then(
    (lease) => {
      // Keep the lease immediately available for disposal while observing the
      // connection that openWsChannel already starts beside snapshot loading.
      if (lease && process.env.WORKFLOW_EVENTS_TRANSPORT === 'eventsync')
        void lease.ready().then(
          () => observeReady('end', 'completed'),
          () => observeReady('end', 'error')
        );
      else if (!lease) observeReady('end', 'error');
      return { lease, error: undefined, failed: false };
    },
    (error: unknown) => {
      observeReady('end', 'error');
      return { lease: undefined, error, failed: true };
    }
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
            ...(process.env.WORKFLOW_EVENTS_TRANSPORT === 'eventsync'
              ? { flushEvent: !onSent }
              : {}),
          }
        : config
    );
  };
  const dispose = () => {
    disposed = true;
    disposal ??= opened.then(async ({ lease }) => {
      if (process.env.WORKFLOW_EVENTS_TRANSPORT === 'eventsync') {
        const { resolveWsTransport } = await import('./ws-transport.js');
        resolveWsTransport(runId, config)?.transport.close(
          'single writer disposed'
        );
      }
      lease?.();
    });
    return disposal;
  };
  return process.env.WORKFLOW_EVENTS_TRANSPORT === 'eventsync'
    ? new BufferedEventWriter(runId, write, dispose, async (head) => {
        const { lease, error, failed } = await opened;
        if (failed) throw error;
        if (!lease) throw new Error('Eventsync channel is unavailable');
        await lease.flushThrough(head);
      })
    : { create: write, dispose };
}
