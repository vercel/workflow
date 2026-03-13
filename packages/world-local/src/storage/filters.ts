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
 * Filter event data based on resolveData setting.
 * When resolveData is 'none', strips eventData to reduce payload size.
 */
export function filterEventData(
  event: Event,
  resolveData: 'none' | 'all'
): Event {
  if (resolveData === 'none') {
    const { eventData: _eventData, ...rest } = event as any;
    const minimalEventData: Record<string, unknown> = {};
    if (_eventData?.stepName !== undefined)
      minimalEventData.stepName = _eventData.stepName;
    if (_eventData?.workflowName !== undefined)
      minimalEventData.workflowName = _eventData.workflowName;
    return {
      ...rest,
      ...(Object.keys(minimalEventData).length > 0
        ? { eventData: minimalEventData }
        : {}),
    };
  }
  return event;
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
