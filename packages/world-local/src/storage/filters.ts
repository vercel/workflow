import type {
  Event,
  Hook,
  Step,
  StepWithoutData,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';

/**
 * Filter run data based on resolveData setting.
 * When resolveData is 'none', strips input/output to reduce payload size.
 */
export function filterRunData(
  run: WorkflowRun,
  resolveData: 'none'
): WorkflowRunWithoutData;
export function filterRunData(
  run: WorkflowRun,
  resolveData: 'all'
): WorkflowRun;
export function filterRunData(
  run: WorkflowRun,
  resolveData: 'none' | 'all'
): WorkflowRun | WorkflowRunWithoutData;
export function filterRunData(
  run: WorkflowRun,
  resolveData: 'none' | 'all'
): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === 'none') {
    return {
      ...run,
      input: undefined,
      output: undefined,
    } as WorkflowRunWithoutData;
  }
  return run;
}

/**
 * Filter step data based on resolveData setting.
 * When resolveData is 'none', strips input/output to reduce payload size.
 */
export function filterStepData(
  step: Step,
  resolveData: 'none'
): StepWithoutData;
export function filterStepData(step: Step, resolveData: 'all'): Step;
export function filterStepData(
  step: Step,
  resolveData: 'none' | 'all'
): Step | StepWithoutData;
export function filterStepData(
  step: Step,
  resolveData: 'none' | 'all'
): Step | StepWithoutData {
  if (resolveData === 'none') {
    return {
      ...step,
      input: undefined,
      output: undefined,
    } as StepWithoutData;
  }
  return step;
}

/**
 * Fields within eventData that hold ref/payload data per event type.
 * When resolveData is 'none', only these fields are stripped — all other
 * metadata (stepName, workflowName, etc.) is preserved.
 */
const EVENT_DATA_REF_FIELDS: Record<string, string[]> = {
  run_created: ['input'],
  run_completed: ['output'],
  run_failed: ['error'],
  step_created: ['input'],
  step_completed: ['result'],
  step_failed: ['error'],
  step_retrying: ['error'],
  hook_created: ['metadata'],
  hook_received: ['payload'],
};

/**
 * Strip ref/payload fields from eventData based on resolveData setting.
 * When resolveData is 'none', removes only large data fields (refs) from
 * eventData while preserving metadata like stepName, workflowName, etc.
 */
export function stripEventDataRefs(
  event: Event,
  resolveData: 'none' | 'all'
): Event {
  if (resolveData !== 'none') return event;
  if (!('eventData' in event)) return event;

  const eventData = (event as any).eventData;
  if (!eventData || typeof eventData !== 'object') {
    const { eventData: _, ...rest } = event as any;
    return rest;
  }

  const refFields = EVENT_DATA_REF_FIELDS[event.eventType];
  if (!refFields || refFields.length === 0) return event;

  const stripped = { ...eventData };
  for (const field of refFields) {
    delete stripped[field];
  }

  const { eventData: _, ...rest } = event as any;
  return {
    ...rest,
    ...(Object.keys(stripped).length > 0 ? { eventData: stripped } : {}),
  };
}

/**
 * Filter hook data based on resolveData setting.
 * When resolveData is 'none', strips metadata to reduce payload size.
 */
export function filterHookData(hook: Hook, resolveData: 'none' | 'all'): Hook {
  if (resolveData === 'none') {
    const { metadata: _metadata, ...rest } = hook as any;
    return rest;
  }
  return hook;
}
