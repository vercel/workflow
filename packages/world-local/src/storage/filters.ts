import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';

/**
 * Filter run data based on resolveData setting.
 * When resolveData is 'none', strips input/output to reduce payload size.
 */
export function filterRunData(
  run: WorkflowRun,
  resolveData: 'none' | 'all'
): WorkflowRun {
  if (resolveData === 'none') {
    return {
      ...run,
      input: [],
      output: undefined,
    };
  }
  return run;
}

/**
 * Filter step data based on resolveData setting.
 * When resolveData is 'none', strips input/output to reduce payload size.
 */
export function filterStepData(step: Step, resolveData: 'none' | 'all'): Step {
  if (resolveData === 'none') {
    return {
      ...step,
      input: [],
      output: undefined,
    };
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
    return rest;
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
