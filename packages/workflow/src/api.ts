import { getWorld } from '@workflow/core/runtime';
import type {
  CancelWorkflowRunParams,
  CreateEventParams,
  CreateEventRequest,
  CreateHookRequest,
  CreateStepRequest,
  CreateWorkflowRunRequest,
  Event,
  GetHookParams,
  GetStepParams,
  GetWorkflowRunParams,
  Hook,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunStepsParams,
  ListWorkflowRunsParams,
  MessageId,
  PaginatedResponse,
  PauseWorkflowRunParams,
  QueuePayload,
  QueuePrefix,
  ResumeWorkflowRunParams,
  Step,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  ValidQueueName,
  WorkflowRun,
  World,
} from '@workflow/world';

export {
  type Event,
  getHookByToken,
  getRun,
  getWorld,
  Run,
  resumeHook,
  resumeWebhook,
  runStep,
  type StartOptions,
  start,
  type WorkflowReadableStreamOptions,
  type WorkflowRun,
} from '@workflow/core/runtime';

export type {
  CancelWorkflowRunParams,
  CreateEventParams,
  CreateEventRequest,
  CreateHookRequest,
  CreateStepRequest,
  CreateWorkflowRunRequest,
  GetHookParams,
  GetStepParams,
  GetWorkflowRunParams,
  Hook,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunStepsParams,
  ListWorkflowRunsParams,
  MessageId,
  PaginatedResponse,
  PauseWorkflowRunParams,
  QueuePayload,
  QueuePrefix,
  ResumeWorkflowRunParams,
  Step,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  ValidQueueName,
} from '@workflow/world';

/**
 * Creates a workflow run using the configured World implementation.
 */
export function createRun(
  data: CreateWorkflowRunRequest
): Promise<WorkflowRun> {
  return getWorld().runs.create(data);
}

/**
 * Retrieves a workflow run record without wrapping it in the `Run` helper.
 */
export function getWorkflowRun(
  runId: string,
  params?: GetWorkflowRunParams
): Promise<WorkflowRun> {
  return getWorld().runs.get(runId, params);
}

/**
 * Updates a workflow run with partial data.
 */
export function updateRun(
  runId: string,
  data: UpdateWorkflowRunRequest
): Promise<WorkflowRun> {
  return getWorld().runs.update(runId, data);
}

/**
 * Lists workflow runs with optional filtering/pagination.
 */
export function listRuns(
  params?: ListWorkflowRunsParams
): Promise<PaginatedResponse<WorkflowRun>> {
  return getWorld().runs.list(params);
}

/**
 * Cancels a workflow run.
 */
export function cancelRun(
  runId: string,
  params?: CancelWorkflowRunParams
): Promise<WorkflowRun> {
  return getWorld().runs.cancel(runId, params);
}

/**
 * Pauses a workflow run.
 */
export function pauseRun(
  runId: string,
  params?: PauseWorkflowRunParams
): Promise<WorkflowRun> {
  return getWorld().runs.pause(runId, params);
}

/**
 * Resumes a previously paused workflow run.
 */
export function resumeRun(
  runId: string,
  params?: ResumeWorkflowRunParams
): Promise<WorkflowRun> {
  return getWorld().runs.resume(runId, params);
}

/**
 * Creates a step record for a workflow run.
 */
export function createStep(
  runId: string,
  data: CreateStepRequest
): Promise<Step> {
  return getWorld().steps.create(runId, data);
}

/**
 * Retrieves a workflow step.
 */
export function getStep(
  runId: string | undefined,
  stepId: string,
  params?: GetStepParams
): Promise<Step> {
  return getWorld().steps.get(runId, stepId, params);
}

/**
 * Updates a workflow step.
 */
export function updateStep(
  runId: string,
  stepId: string,
  data: UpdateStepRequest
): Promise<Step> {
  return getWorld().steps.update(runId, stepId, data);
}

/**
 * Lists steps for a workflow run.
 */
export function listSteps(
  params: ListWorkflowRunStepsParams
): Promise<PaginatedResponse<Step>> {
  return getWorld().steps.list(params);
}

/**
 * Creates an event associated with a workflow run.
 */
export function createEvent(
  runId: string,
  data: CreateEventRequest,
  params?: CreateEventParams
): Promise<Event> {
  return getWorld().events.create(runId, data, params);
}

/**
 * Lists events for a workflow run.
 */
export function listEvents(
  params: ListEventsParams
): Promise<PaginatedResponse<Event>> {
  return getWorld().events.list(params);
}

/**
 * Lists events filtered by correlation ID across runs.
 */
export function listEventsByCorrelationId(
  params: ListEventsByCorrelationIdParams
): Promise<PaginatedResponse<Event>> {
  return getWorld().events.listByCorrelationId(params);
}

/**
 * Creates a hook for a workflow run.
 */
export function createHook(
  runId: string,
  data: CreateHookRequest,
  params?: GetHookParams
): Promise<Hook> {
  return getWorld().hooks.create(runId, data, params);
}

/**
 * Retrieves a hook by ID.
 */
export function getHook(hookId: string, params?: GetHookParams): Promise<Hook> {
  return getWorld().hooks.get(hookId, params);
}

/**
 * Lists hooks with optional filters.
 */
export function listHooks(
  params: ListHooksParams
): Promise<PaginatedResponse<Hook>> {
  return getWorld().hooks.list(params);
}

/**
 * Disposes an existing hook.
 */
export function disposeHook(
  hookId: string,
  params?: GetHookParams
): Promise<Hook> {
  return getWorld().hooks.dispose(hookId, params);
}

/**
 * Returns the deployment ID used by the underlying queue implementation.
 */
export function getDeploymentId(): Promise<string> {
  return getWorld().getDeploymentId();
}

/**
 * Enqueues a message for workflow or step execution.
 */
export function queue(
  queueName: ValidQueueName,
  message: QueuePayload,
  opts?: { deploymentId?: string; idempotencyKey?: string }
): Promise<{ messageId: MessageId }> {
  return getWorld().queue(queueName, message, opts);
}

/**
 * Creates an HTTP handler for the provided queue prefix.
 */
export function createQueueHandler(
  queueNamePrefix: QueuePrefix,
  handler: Parameters<World['createQueueHandler']>[1]
): ReturnType<World['createQueueHandler']> {
  return getWorld().createQueueHandler(queueNamePrefix, handler);
}

/**
 * Writes chunked data to a named stream.
 */
export function writeToStream(
  name: string,
  chunk: string | Uint8Array
): Promise<void> {
  return getWorld().writeToStream(name, chunk);
}

/**
 * Closes a named stream.
 */
export function closeStream(name: string): Promise<void> {
  return getWorld().closeStream(name);
}

/**
 * Reads data from a named stream.
 */
export function readFromStream(
  name: string,
  startIndex?: number
): Promise<ReadableStream<Uint8Array>> {
  return getWorld().readFromStream(name, startIndex);
}

/**
 * Starts any background services provided by the configured World.
 */
export async function startWorld(): Promise<void> {
  await getWorld().start?.();
}
