import type { EventWriteSession } from '@workflow/world';
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
  return {
    async create(event, params) {
      if (disposed) throw new Error('Event writer is disposed');
      const { lease, error, failed } = await opened;
      if (failed) throw error;
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
        lease ? { ...config, requireWsEvents: true } : config
      );
    },
    dispose() {
      disposed = true;
      disposal ??= opened.then(({ lease }) => {
        lease?.();
      });
      return disposal;
    },
  };
}
