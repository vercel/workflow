import type { Storage } from '@workflow/world';
import { createWorkflowRunEvent, getWorkflowRunEvents } from './events.js';
import {
  createHook,
  disposeHook,
  getHook,
  getHookByToken,
  listHooks,
} from './hooks.js';
import {
  cancelWorkflowRun,
  createWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  updateWorkflowRun,
} from './runs.js';
import {
  createStep,
  getStep,
  listWorkflowRunSteps,
  updateStep,
} from './steps.js';
import type { APIConfig } from './utils.js';

export function createStorage(config?: APIConfig): Storage {
  return {
    // Storage interface with namespaced methods
    runs: {
      create: (data) => createWorkflowRun(data, config),
      get: (id, params) => getWorkflowRun(id, params, config),
      update: (id, data) => updateWorkflowRun(id, data, config),
      list: (params) => listWorkflowRuns(params, config),
      cancel: (id, params) => cancelWorkflowRun(id, params, config),
    },
    steps: {
      create: (runId, data) => createStep(runId, data, config),
      get: (runId, stepId, params) => getStep(runId, stepId, params, config),
      update: (runId, stepId, data) => updateStep(runId, stepId, data, config),
      list: (params) => listWorkflowRunSteps(params, config),
    },
    events: {
      create: (runId, data, params) =>
        createWorkflowRunEvent(runId, data, params, config),
      list: (params) => getWorkflowRunEvents(params, config),
      listByCorrelationId: (params) => getWorkflowRunEvents(params, config),
    },
    hooks: {
      create: (runId, data) => createHook(runId, data, config),
      get: (hookId, params) => getHook(hookId, params, config),
      getByToken: (token) => getHookByToken(token, config),
      list: (params) => listHooks(params, config),
      dispose: (hookId) => disposeHook(hookId, config),
    },
  };
}
