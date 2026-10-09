import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import type {
  CreateEventParams,
  CreateEventRequest,
  EventResult,
  EventWriteSession,
} from '@workflow/world';
import {
  BufferedEventWriter,
  type WriterCatchUp,
} from './buffered-event-writer.js';
import { createWorkflowRunEvent } from './events.js';
import { decodeEventFrameSequence } from './events-v4.js';
import {
  affinityForMarker,
  ownerAffinity,
  singleOwnerMarker,
} from './run-affinity.js';
import type { APIConfig } from './utils.js';
import { isWsEventsTransportEnabled } from './ws-transport-enabled.js';

/**
 * The single-owner runner's write session for one run: eventsync, the
 * single-writer transport into the run's canonical event log. An owner loop
 * holds this lease across inputs, asynchronous steps and idle waits.
 */
export function createEventWriteSession(
  runId: string,
  config?: APIConfig
): EventWriteSession {
  let disposed = false;
  const observations = channel('workflow.eventsync');
  const spanId = randomUUID();
  const started = performance.now();
  const observeReady = (event: 'begin' | 'end', status?: string) => {
    if (observations.hasSubscribers)
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
  // Eventsync: every (re)connect resumes from the writer's committed head. The
  // initial connection opens at 0, so its catch-up is the owner's history.
  let writer: BufferedEventWriter | undefined;
  const catchUp = {
    position: () => writer?.position ?? 0,
    decode: decodeEventFrameSequence as (
      body: Uint8Array
    ) => Promise<unknown[]>,
    verify: (events: unknown[], after: number) =>
      verifyOwnerAffinity(runId, events, after),
    fresh: () => writer?.fresh ?? false,
  };
  // Handle rejection immediately even when snapshot loading fails before a write.
  const opened = (
    isWsEventsTransportEnabled()
      ? import('./ws-transport.js').then(({ openWsChannel }) =>
          openWsChannel(runId, config, { catchUp })
        )
      : Promise.resolve(undefined)
  ).then(
    (lease) => {
      // Keep the lease immediately available for disposal while observing the
      // connection that openWsChannel already starts beside snapshot loading.
      if (lease)
        void lease.ready().then(
          () => observeReady('end', 'completed'),
          () => observeReady('end', 'error')
        );
      else observeReady('end', 'error');
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
    onSent?: () => void,
    generation?: number
  ): Promise<EventResult> => {
    if (disposed) throw new Error('Event writer is disposed');
    const { lease, error, failed } = await opened;
    if (failed) throw error;
    if (!lease)
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
      {
        ...config,
        requireWsEvents: true,
        onEventSent: onSent,
        failStopEventWrites: true,
        flushEvent: !onSent,
        wsGeneration: generation,
      }
    );
  };
  const dispose = () => {
    disposed = true;
    disposal ??= opened.then(async ({ lease }) => {
      const { resolveWsTransport } = await import('./ws-transport.js');
      resolveWsTransport(runId, config)?.transport.close(
        'single writer disposed'
      );
      lease?.();
    });
    return disposal;
  };
  const lease = async () => {
    const { lease, error, failed } = await opened;
    if (failed) throw error;
    if (!lease) throw new Error('Eventsync channel is unavailable');
    return lease;
  };
  writer = new BufferedEventWriter(
    runId,
    write,
    dispose,
    async (head, generation) => (await lease()).flushThrough(head, generation),
    async () => (await lease()).takeCatchUp() as Promise<WriterCatchUp>
  );
  return writer;
}

/**
 * The owner's check that it owns the run, once its first catch-up has the
 * run's `run_created`: the affinity this process was invoked under must be the
 * one the run's single-owner marker routes to. Anything else is a stale or
 * misrouted invocation, which must stop before writing.
 */
function verifyOwnerAffinity(runId: string, events: unknown[], after: number) {
  if (after !== 0) return;
  const invoked = ownerAffinity(runId);
  const created = events[0] as
    | {
        eventType?: string;
        eventData?: {
          attributes?: Record<string, unknown>;
          deploymentId?: string;
        };
      }
    | undefined;
  if (invoked === undefined || created?.eventType !== 'run_created') return;
  const marker = singleOwnerMarker(created.eventData?.attributes);
  const expected =
    marker === undefined
      ? runId
      : affinityForMarker(runId, marker, created.eventData?.deploymentId);
  if (invoked !== expected)
    throw new Error(`Run is routed to affinity ${expected}, not ${invoked}`);
}
