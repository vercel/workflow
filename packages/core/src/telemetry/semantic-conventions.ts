/**
 * OpenTelemetry semantic conventions for Vercel Workflow telemetry.
 *
 * This module provides standardized telemetry attributes following OpenTelemetry semantic conventions
 * for instrumenting workflow execution, step processing, and related operations. Each exported function
 * creates a properly formatted attribute object that can be used with OpenTelemetry spans.
 *
 * The semantic conventions are organized into several categories:
 * - **Workflow attributes**: Track workflow lifecycle, status, and metadata
 * - **Step attributes**: Monitor individual step execution, retries, and results
 * - **Queue attributes**: Instrument message queue operations
 * - **Deployment attributes**: Capture deployment environment information
 *
 * All attribute functions are type-safe and leverage existing backend types to ensure
 * consistency between telemetry data and actual system state.
 *
 * @example
 * ```typescript
 * import * as Attribute from './telemetry/semantic-conventions.js';
 *
 * // Set workflow attributes on a span
 * span.setAttributes({
 *   ...Attribute.WorkflowName('my-workflow'),
 *   ...Attribute.WorkflowOperation('start'),
 *   ...Attribute.WorkflowRunStatus('running'),
 * });
 *
 * // Set step attributes
 * span.setAttributes({
 *   ...Attribute.StepName('process-data'),
 *   ...Attribute.StepStatus('completed'),
 *   ...Attribute.StepAttempt(1),
 * });
 * ```
 *
 * @see {@link https://opentelemetry.io/docs/specs/semconv/} OpenTelemetry Semantic Conventions
 * @packageDocumentation
 */

import type { MessageId, Step, WorkflowRun } from '@workflow/world';

/**
 * Creates a semantic convention function that returns an attribute object.
 * @param name - The attribute name following OpenTelemetry semantic conventions
 * @returns A function that takes a value and returns an attribute object
 */
function SemanticConvention<T>(...names: string[]) {
  return (value: T) =>
    Object.fromEntries(names.map((name) => [name, value] as const));
}

// Workflow attributes

/** The name of the workflow being executed */
export const WorkflowName = SemanticConvention<string>('workflow.name');

/** The operation being performed on the workflow */
export const WorkflowOperation = SemanticConvention<
  'start' | 'execute' | 'run'
>('workflow.operation');

/** Unique identifier for a specific workflow run instance */
export const WorkflowRunId = SemanticConvention<string>('workflow.run.id');

/** Current status of the workflow run */
export const WorkflowRunStatus = SemanticConvention<
  WorkflowRun['status'] | 'pending_steps'
>('workflow.run.status');

/** Timestamp when the workflow execution started (Unix timestamp) */
export const WorkflowStartedAt = SemanticConvention<number>(
  'workflow.started_at'
);

/** Number of events processed during workflow execution */
export const WorkflowEventsCount = SemanticConvention<number>(
  'workflow.events.count'
);

/** Number of arguments passed to the workflow */
export const WorkflowArgumentsCount = SemanticConvention<number>(
  'workflow.arguments.count'
);

/** Type of the workflow result */
export const WorkflowResultType = SemanticConvention<string>(
  'workflow.result.type'
);

/** Whether trace context was propagated to this workflow execution */
export const WorkflowTracePropagated = SemanticConvention<boolean>(
  'workflow.trace.propagated'
);

/** Name of the error that caused workflow failure */
export const WorkflowErrorName = SemanticConvention<string>(
  'workflow.error.name'
);

/** Error message when workflow fails */
export const WorkflowErrorMessage = SemanticConvention<string>(
  'workflow.error.message'
);

/** Number of steps created during workflow execution */
export const WorkflowStepsCreated = SemanticConvention<number>(
  'workflow.steps.created'
);

// Step attributes

/** Name of the step function being executed */
export const StepName = SemanticConvention<string>('step.name');

/** Unique identifier for the step instance */
export const StepId = SemanticConvention<string>('step.id');

/** Current attempt number for step execution (starts at 1) */
export const StepAttempt = SemanticConvention<number>('step.attempt');

/** Current status of the step */
export const StepStatus = SemanticConvention<Step['status']>('step.status');

/** Maximum number of retries allowed for this step */
export const StepMaxRetries = SemanticConvention<number>('step.max_retries');

/** Whether trace context was propagated to this step execution */
export const StepTracePropagated = SemanticConvention<boolean>(
  'step.trace.propagated'
);

/** Whether the step was skipped during execution */
export const StepSkipped = SemanticConvention<boolean>('step.skipped');

/** Reason why the step was skipped */
export const StepSkipReason =
  SemanticConvention<Step['status']>('step.skip_reason');

/** Number of arguments passed to the step function */
export const StepArgumentsCount = SemanticConvention<number>(
  'step.arguments.count'
);

/** Type of the step result */
export const StepResultType = SemanticConvention<string>('step.result.type');

/** Name of the error that caused step failure */
export const StepErrorName = SemanticConvention<string>('step.error.name');

/** Error message when step fails */
export const StepErrorMessage =
  SemanticConvention<string>('step.error.message');

/** Whether the step failed with a fatal error (no retries) */
export const StepFatalError = SemanticConvention<boolean>('step.fatal_error');

/** Whether all retry attempts have been exhausted */
export const StepRetryExhausted = SemanticConvention<boolean>(
  'step.retry.exhausted'
);

/** Number of seconds to wait before next retry attempt */
export const StepRetryTimeoutSeconds = SemanticConvention<number>(
  'step.retry.timeout_seconds'
);

/** Whether the step will be retried after this failure */
export const StepRetryWillRetry = SemanticConvention<boolean>(
  'step.retry.will_retry'
);

// Queue attributes

/** Name of the queue being used for message processing */
export const QueueName = SemanticConvention<string>('queue.name');

/** The message id being handled */
export const QueueMessageId = SemanticConvention<MessageId>(
  'messaging.message.id',
  'queue.message.id'
);

/** Time taken to enqueue the message in milliseconds */
export const QueueOverheadMs = SemanticConvention<number>('queue.overhead_ms');

// Deployment attributes

/** Unique identifier for the deployment environment */
export const DeploymentId = SemanticConvention<string>('deployment.id');

// Hook attributes

/** Token identifying a specific hook */
export const HookToken = SemanticConvention<string>('workflow.hook.token');

/** Unique identifier for a hook instance */
export const HookId = SemanticConvention<string>('workflow.hook.id');

/** Whether a hook was found by its token */
export const HookFound = SemanticConvention<boolean>('workflow.hook.found');

// Webhook attributes

/** Number of webhook handlers triggered */
export const WebhookHandlersTriggered = SemanticConvention<number>(
  'webhook.handlers.triggered'
);
