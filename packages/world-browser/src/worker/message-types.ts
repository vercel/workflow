/**
 * Message types for SharedWorker communication.
 */

import type { WorkflowRun, Step, Event } from '@workflow/world';

// Request message types
export type WorkerRequestType =
  | 'TRIGGER'
  | 'GET_STATUS'
  | 'LIST_RUNS'
  | 'CANCEL'
  | 'PAUSE'
  | 'RESUME'
  | 'SUBSCRIBE'
  | 'UNSUBSCRIBE'
  | 'GET_STEPS'
  | 'GET_EVENTS';

export interface WorkerRequest {
  id: string;
  type: WorkerRequestType;
}

export interface TriggerRequest extends WorkerRequest {
  type: 'TRIGGER';
  workflowId: string;
  args: unknown[];
}

export interface GetStatusRequest extends WorkerRequest {
  type: 'GET_STATUS';
  runId: string;
}

export interface ListRunsRequest extends WorkerRequest {
  type: 'LIST_RUNS';
  workflowName?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

export interface CancelRequest extends WorkerRequest {
  type: 'CANCEL';
  runId: string;
}

export interface PauseRequest extends WorkerRequest {
  type: 'PAUSE';
  runId: string;
}

export interface ResumeRequest extends WorkerRequest {
  type: 'RESUME';
  runId: string;
}

export interface SubscribeRequest extends WorkerRequest {
  type: 'SUBSCRIBE';
  runId: string;
}

export interface UnsubscribeRequest extends WorkerRequest {
  type: 'UNSUBSCRIBE';
  runId: string;
}

export interface GetStepsRequest extends WorkerRequest {
  type: 'GET_STEPS';
  runId: string;
}

export interface GetEventsRequest extends WorkerRequest {
  type: 'GET_EVENTS';
  runId: string;
}

export type AnyWorkerRequest =
  | TriggerRequest
  | GetStatusRequest
  | ListRunsRequest
  | CancelRequest
  | PauseRequest
  | ResumeRequest
  | SubscribeRequest
  | UnsubscribeRequest
  | GetStepsRequest
  | GetEventsRequest;

// Response message types
export interface WorkerResponse {
  id: string;
  success: boolean;
}

export interface SuccessResponse<T = unknown> extends WorkerResponse {
  success: true;
  data: T;
}

export interface ErrorResponse extends WorkerResponse {
  success: false;
  error: string;
}

export type AnyWorkerResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

// Event message types (pushed from worker to client)
export type WorkerEventType =
  | 'RUN_UPDATED'
  | 'STEP_UPDATED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED';

export interface WorkerEvent {
  type: WorkerEventType;
  runId: string;
}

export interface RunUpdatedEvent extends WorkerEvent {
  type: 'RUN_UPDATED';
  run: WorkflowRun;
}

export interface StepUpdatedEvent extends WorkerEvent {
  type: 'STEP_UPDATED';
  step: Step;
}

export interface RunCompletedEvent extends WorkerEvent {
  type: 'RUN_COMPLETED';
  run: WorkflowRun;
}

export interface RunFailedEvent extends WorkerEvent {
  type: 'RUN_FAILED';
  run: WorkflowRun;
  error: string;
}

export type AnyWorkerEvent =
  | RunUpdatedEvent
  | StepUpdatedEvent
  | RunCompletedEvent
  | RunFailedEvent;

// Trigger response
export interface TriggerResponse {
  runId: string;
}

// List runs response
export interface ListRunsResponse {
  data: WorkflowRun[];
  hasMore: boolean;
  cursor: string | null;
}

// Steps response
export interface GetStepsResponse {
  data: Step[];
  hasMore: boolean;
  cursor: string | null;
}

// Events response
export interface GetEventsResponse {
  data: Event[];
  hasMore: boolean;
  cursor: string | null;
}
