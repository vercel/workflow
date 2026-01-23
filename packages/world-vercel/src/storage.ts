import type { Storage } from '@workflow/world';
import { createWorkflowRunEvent, getWorkflowRunEvents } from './events.js';
import { getHook, getHookByToken, listHooks } from './hooks.js';
import { getWorkflowRun, listWorkflowRuns } from './runs.js';
import { getStep, listWorkflowRunSteps } from './steps.js';
import type { APIConfig } from './utils.js';

export function createStorage(config?: APIConfig): Storage {
  return {
    // Storage interface with namespaced methods
    runs: {
      get: (id, params) => getWorkflowRun(id, params, config),
      list: (params) => listWorkflowRuns(params, config),
    },
    steps: {
      get: (runId, stepId, params) => getStep(runId, stepId, params, config),
      list: (params) => listWorkflowRunSteps(params, config),
    },
    events: {
      create: (runId, data, params) =>
        createWorkflowRunEvent(runId, data, params, config),
      list: (params) => getWorkflowRunEvents(params, config),
      listByCorrelationId: (params) => getWorkflowRunEvents(params, config),
    },
    hooks: {
      get: (hookId, params) => getHook(hookId, params, config),
      getByToken: (token) => getHookByToken(token, config),
      list: (params) => listHooks(params, config),
    },
  };
}
