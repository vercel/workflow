import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
} from './events.js';
import type {
  CreateHookRequest,
  GetHookParams,
  Hook,
  ListHooksParams,
} from './hooks.js';
import type { Queue } from './queue.js';
import type {
  CancelWorkflowRunParams,
  CreateWorkflowRunRequest,
  GetWorkflowRunParams,
  ListWorkflowRunsParams,
  UpdateWorkflowRunRequest,
  WorkflowRun,
} from './runs.js';
import type { PaginatedResponse } from './shared.js';
import type {
  CreateStepRequest,
  GetStepParams,
  ListWorkflowRunStepsParams,
  Step,
  UpdateStepRequest,
} from './steps.js';

export interface Streamer {
  writeToStream(
    name: string,
    runId: string | Promise<string>,
    chunk: string | Uint8Array
  ): Promise<void>;
  closeStream(name: string, runId: string | Promise<string>): Promise<void>;
  readFromStream(
    name: string,
    startIndex?: number
  ): Promise<ReadableStream<Uint8Array>>;
  listStreamsByRunId(runId: string): Promise<string[]>;
}

export interface Storage {
  runs: {
    create(data: CreateWorkflowRunRequest): Promise<WorkflowRun>;
    get(id: string, params?: GetWorkflowRunParams): Promise<WorkflowRun>;
    update(id: string, data: UpdateWorkflowRunRequest): Promise<WorkflowRun>;
    list(
      params?: ListWorkflowRunsParams
    ): Promise<PaginatedResponse<WorkflowRun>>;
    cancel(id: string, params?: CancelWorkflowRunParams): Promise<WorkflowRun>;
  };

  steps: {
    create(runId: string, data: CreateStepRequest): Promise<Step>;
    get(
      runId: string | undefined,
      stepId: string,
      params?: GetStepParams
    ): Promise<Step>;
    update(
      runId: string,
      stepId: string,
      data: UpdateStepRequest
    ): Promise<Step>;
    list(params: ListWorkflowRunStepsParams): Promise<PaginatedResponse<Step>>;
  };

  events: {
    create(
      runId: string,
      data: CreateEventRequest,
      params?: CreateEventParams
    ): Promise<Event>;
    list(params: ListEventsParams): Promise<PaginatedResponse<Event>>;
    listByCorrelationId(
      params: ListEventsByCorrelationIdParams
    ): Promise<PaginatedResponse<Event>>;
  };

  hooks: {
    create(
      runId: string,
      data: CreateHookRequest,
      params?: GetHookParams
    ): Promise<Hook>;
    get(hookId: string, params?: GetHookParams): Promise<Hook>;
    getByToken(token: string, params?: GetHookParams): Promise<Hook>;
    list(params: ListHooksParams): Promise<PaginatedResponse<Hook>>;
    dispose(hookId: string, params?: GetHookParams): Promise<Hook>;
  };
}

/**
 * The "World" interface represents how Workflows are able to communicate with the outside world.
 */
export interface World extends Queue, Storage, Streamer {
  /**
   * A function that will be called to start any background tasks needed by the World implementation.
   * For example, in the case of a queue backed World, this would start the queue processing.
   */
  start?(): Promise<void>;
}
