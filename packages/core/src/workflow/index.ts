import type { StepMetadata } from '../step/get-step-metadata.js';

export {
  FatalError,
  RetryableError,
  type RetryableErrorOptions,
} from '@workflow/errors';
export type { Hook, HookOptions } from '../create-hook.js';
export { createHook, createWebhook } from './create-hook.js';
export { defineHook } from './define-hook.js';
export { getWorkflowMetadata } from './get-workflow-metadata.js';
export { sleep } from '../sleep.js';
export { getWritable } from './writable-stream.js';

// workflows can't use these functions, but we still need to provide
// the export so bundling doesn't fail when step and workflow are in same file
export function getStepMetadata(): StepMetadata {
  throw new Error(
    '`getStepMetadata()` can only be called inside a step function'
  );
}
export function resumeHook() {
  throw new Error(
    '`resumeHook()` can only be called from outside a workflow function'
  );
}
