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
      get: ((id: string, params?: any) =>
        getWorkflowRun(id, params, config)) as Storage['runs']['get'],
      list: ((params?: any) =>
        listWorkflowRuns(params, config)) as Storage['runs']['list'],
    },
    steps: {
      get: ((runId: string | undefined, stepId: string, params?: any) =>
        getStep(runId, stepId, params, config)) as Storage['steps']['get'],
      list: ((params: any) =>
        listWorkflowRunSteps(params, config)) as Storage['steps']['list'],
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
