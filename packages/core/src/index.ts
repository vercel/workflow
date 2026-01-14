/**
 * Just the core utilities that are meant to be imported by user
 * steps/workflows. This allows the bundler to tree-shake and limit what goes
 * into the final user bundles. Logic for running/handling steps/workflows
 * should live in runtime. Eventually these might be separate packages
 * `workflow` and `workflow/runtime`?
 *
 * Everything here will get re-exported under the 'workflow' top level package.
 * This should be a minimal set of APIs so **do not anything here** unless it's
 * needed for userland workflow code.
 */

export {
  FatalError,
  RetryableError,
  type RetryableErrorOptions,
} from '@workflow/errors';
export {
  createHook,
  createWebhook,
  type Hook,
  type HookOptions,
  type RequestWithResponse,
  type Webhook,
  type WebhookOptions,
} from './create-hook.js';
export { defineHook, type TypedHook } from './define-hook.js';
export { sleep } from './sleep.js';
export {
  getStepMetadata,
  type StepMetadata,
} from './step/get-step-metadata.js';
export {
  getWorkflowMetadata,
  type WorkflowMetadata,
} from './step/get-workflow-metadata.js';
export {
  getWritable,
  type WorkflowWritableStreamOptions,
} from './step/writable-stream.js';
