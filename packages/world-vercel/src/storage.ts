import type {
  AnyEventRequest,
  CreateEventParams,
  Storage,
} from '@workflow/world';
import { SPEC_VERSION_SINGLE_ORCHESTRATOR } from '@workflow/world';
import {
  createWorkflowRunEvent,
  createWorkflowRunEventBatch,
  getEvent,
  getWorkflowRunEvents,
} from './events.js';
import {
  cursorAfterSlot,
  GAP_FILL_PAGE_SIZE,
  subscribeRunEvents,
} from './events-live-feed.js';
import { getHook, getHookByToken, listHooks } from './hooks.js';
import { instrumentObject } from './instrumentObject.js';
import {
  cancelWorkflowRuns,
  experimentalSetAttributes,
  getWorkflowRun,
  getWorkflowRuns,
  listWorkflowRuns,
  purgeWorkflowRuns,
  waitForWorkflowRunTerminalStatus,
} from './runs.js';
import { createSnapshotsStorage } from './snapshots.js';
import { getStep, listWorkflowRunSteps } from './steps.js';
import type { APIConfig } from './utils.js';

export function createStorage(config?: APIConfig): Storage {
  const snapshots = createSnapshotsStorage(config);
  const storage: Storage = {
    // Storage interface with namespaced methods
    runs: {
      get: ((id: string, params?: any) =>
        getWorkflowRun(id, params, config)) as Storage['runs']['get'],
      waitForTerminalStatus: ((id: string, params?: any) =>
        waitForWorkflowRunTerminalStatus(id, params, config)) as NonNullable<
        Storage['runs']['waitForTerminalStatus']
      >,
      getMany: ((ids: readonly string[], params?: any) =>
        getWorkflowRuns(ids, params, config)) as NonNullable<
        Storage['runs']['getMany']
      >,
      list: ((params?: any) =>
        listWorkflowRuns(params, config)) as Storage['runs']['list'],
      experimentalSetAttributes: (runId, changes, options) =>
        experimentalSetAttributes(runId, changes, options, config),
      cancelMany: (request) => cancelWorkflowRuns(request, config),
      purgeMany: (request) => purgeWorkflowRuns(request, config),
    },
    steps: {
      get: ((runId: string, stepId: string, params?: any) =>
        getStep(runId, stepId, params, config)) as Storage['steps']['get'],
      list: ((params: any) =>
        listWorkflowRunSteps(params, config)) as Storage['steps']['list'],
    },
    events: {
      create: (
        runId: string | null,
        data: AnyEventRequest,
        params?: CreateEventParams
      ) => createWorkflowRunEvent(runId, data, params, config),
      createBatch: (runId, events, params) =>
        createWorkflowRunEventBatch(runId, events, params, config),
      get: (runId, eventId, params) => getEvent(runId, eventId, params, config),
      list: (params) => getWorkflowRunEvents(params, config),
      listByCorrelationId: (params) => getWorkflowRunEvents(params, config),
    },
    hooks: {
      get: (hookId, params) => getHook(hookId, params, config),
      getByToken: (token) => getHookByToken(token, config),
      list: (params) => listHooks(params, config),
    },
    experimental_snapshots: snapshots,
  };

  // Instrument all storage methods with tracing
  // NOTE: Span names are lowercase per OTEL semantic conventions
  return {
    runs: instrumentObject('world.runs', storage.runs),
    steps: instrumentObject('world.steps', storage.steps),
    events: {
      ...instrumentObject('world.events', storage.events),
      // Outside the instrumentation: it returns its unsubscribe synchronously
      // and stays open for a whole blocked wait, so a per-call span would
      // measure nothing.
      subscribe: (runId, afterSlot, onEvent, options) =>
        subscribeRunEvents(
          runId,
          afterSlot,
          onEvent,
          options,
          config,
          // Fills a gap a heartbeat reveals: the log after the last slot the
          // subscription delivered, as the runtime's own poll reads it.
          (after) =>
            storage.events.list({
              runId,
              pagination: {
                sortOrder: 'asc',
                limit: GAP_FILL_PAGE_SIZE,
                ...(after >= 1 ? { cursor: cursorAfterSlot(after) } : {}),
              },
              resolveData: 'all',
              specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
            })
        ),
    },
    hooks: instrumentObject('world.hooks', storage.hooks),
    experimental_snapshots: instrumentObject(
      'world.experimental_snapshots',
      snapshots
    ),
  };
}
