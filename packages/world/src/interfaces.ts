import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  RunCreatedEventRequest,
} from './events.js';
import type { GetHookParams, Hook, ListHooksParams } from './hooks.js';
import type { Queue } from './queue.js';
import type {
  GetWorkflowRunParams,
  ListWorkflowRunsParams,
  WorkflowRun,
} from './runs.js';
import type { PaginatedResponse } from './shared.js';
import type {
  GetStepParams,
  ListWorkflowRunStepsParams,
  Step,
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

/**
 * Storage interface for workflow data.
 *
 * Workflow storage models an append-only event log, so all state changes are handled through `events.create()`.
 * Run/Step/Hook entities provide materialized views into the current state, but entities can't be modified directly.
 *
 * User-originated state changes are also handled via events:
 * - run_cancelled event for run cancellation
 * - hook_disposed event for explicit hook disposal (optional)
 *
 * Note: Hooks are automatically disposed by the World implementation when a workflow
 * reaches a terminal state (run_completed, run_failed, run_cancelled). This releases
 * hook tokens for reuse by future workflows. The hook_disposed event is only needed
 * for explicit disposal before workflow completion.
 */
export interface Storage {
  runs: {
    get(id: string, params?: GetWorkflowRunParams): Promise<WorkflowRun>;
    list(
      params?: ListWorkflowRunsParams
    ): Promise<PaginatedResponse<WorkflowRun>>;
  };

  steps: {
    get(
      runId: string | undefined,
      stepId: string,
      params?: GetStepParams
    ): Promise<Step>;
    list(params: ListWorkflowRunStepsParams): Promise<PaginatedResponse<Step>>;
  };

  events: {
    /**
     * Create a run_created event to start a new workflow run.
     * The runId parameter must be null - the server generates and returns the runId.
     *
     * @param runId - Must be null for run_created events
     * @param data - The run_created event data
     * @param params - Optional parameters for event creation
     * @returns Promise resolving to the created event and run entity
     */
    create(
      runId: null,
      data: RunCreatedEventRequest,
      params?: CreateEventParams
    ): Promise<EventResult>;

    /**
     * Create an event for an existing workflow run and atomically update the entity.
     * Returns both the event and the affected entity (run/step/hook).
     *
     * @param runId - The workflow run ID (required for all events except run_created)
     * @param data - The event to create
     * @param params - Optional parameters for event creation
     * @returns Promise resolving to the created event and affected entity
     */
    create(
      runId: string,
      data: CreateEventRequest,
      params?: CreateEventParams
    ): Promise<EventResult>;

    list(params: ListEventsParams): Promise<PaginatedResponse<Event>>;
    listByCorrelationId(
      params: ListEventsByCorrelationIdParams
    ): Promise<PaginatedResponse<Event>>;
  };

  hooks: {
    get(hookId: string, params?: GetHookParams): Promise<Hook>;
    getByToken(token: string, params?: GetHookParams): Promise<Hook>;
    list(params: ListHooksParams): Promise<PaginatedResponse<Hook>>;
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
