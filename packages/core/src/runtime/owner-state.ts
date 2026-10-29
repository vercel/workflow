import type { Event, Step, WorkflowRun } from '@workflow/world';

/**
 * Event-sourced owner state. The retained owner initializes from its catch-up
 * stream alone: the run from `run_created` plus lifecycle events, Steps from
 * their transitions. Timestamps are event time, as in the backend's journal
 * projection.
 */
export function runFromCreation(event: Event): WorkflowRun {
  if (event.eventType !== 'run_created')
    throw new Error('Run history must begin with run_created');
  const data = event.eventData;
  return {
    runId: event.runId,
    status: 'pending',
    deploymentId: data.deploymentId,
    workflowName: data.workflowName,
    specVersion: event.specVersion,
    executionContext: data.executionContext,
    input: data.input,
    attributes: { ...(data.attributes ?? {}) },
    ...(data.encryptionPublicKey
      ? { encryptionPublicKey: data.encryptionPublicKey }
      : {}),
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  } as WorkflowRun;
}

/** Apply one event to the Step map; non-step events are ignored. */
export function reduceStep(steps: Map<string, Step>, event: Event): void {
  if (!event.eventType.startsWith('step_') || !event.correlationId) return;
  const stepId = event.correlationId;
  const data = (event.eventData ?? {}) as Record<string, unknown>;
  const time = event.createdAt;
  const previous = steps.get(stepId);
  if (event.eventType === 'step_created') {
    if (previous) throw new Error(`Duplicate step creation: ${stepId}`);
    steps.set(stepId, {
      runId: event.runId,
      stepId,
      stepName: String(data.stepName),
      status: 'pending',
      attempt: 0,
      input: data.input as Step['input'],
      createdAt: time,
      updatedAt: time,
      specVersion: event.specVersion,
    });
    return;
  }
  // A lazily created step is born running by its first start.
  const step: Step = previous
    ? { ...previous, updatedAt: time }
    : {
        runId: event.runId,
        stepId,
        stepName: String(data.stepName),
        status: 'pending',
        attempt: 0,
        input: data.input as Step['input'],
        createdAt: time,
        updatedAt: time,
        specVersion: event.specVersion,
      };
  if (!previous && event.eventType !== 'step_started')
    throw new Error(`Step transition without creation: ${stepId}`);
  switch (event.eventType) {
    case 'step_started':
      step.status = 'running';
      step.attempt++;
      step.startedAt ??= time;
      delete step.retryAfter;
      break;
    case 'step_completed':
      step.status = 'completed';
      step.output = data.result as Step['output'];
      step.completedAt = time;
      break;
    case 'step_failed':
      step.status = 'failed';
      step.error = data.error as Step['error'];
      step.completedAt = time;
      break;
    case 'step_retrying':
      step.status = 'pending';
      step.error = data.error as Step['error'];
      step.retryAfter =
        data.retryAfter === undefined
          ? undefined
          : new Date(data.retryAfter as string | Date);
      break;
    default:
      return;
  }
  steps.set(stepId, step);
}
