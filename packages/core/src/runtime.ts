import { workflowEntrypoint as flowWorkflowEntrypoint } from './runtime/flow-entrypoint.js';
import { registerBundledQuickJSEngine } from './runtime/quickjs-engine.js';

export type { Event, WorkflowRun } from '@workflow/world';
export { WorkflowSuspension } from './global.js';

/**
 * Creates the route that runs this app's workflow and step deliveries (see
 * `runtime/flow-entrypoint.ts`), with the QuickJS engine registered for
 * them. The per-workflow inline entries use the engine-less variant.
 */
export function workflowEntrypoint(
  ...args: Parameters<typeof flowWorkflowEntrypoint>
): ReturnType<typeof flowWorkflowEntrypoint> {
  registerBundledQuickJSEngine();
  return flowWorkflowEntrypoint(...args);
}
export {
  type HealthCheckOptions,
  type HealthCheckResult,
  healthCheck,
} from './runtime/helpers.js';
export {
  type PrecompiledQuickJSModules,
  setPrecompiledQuickJSModules,
} from './runtime/quickjs-precompiled.js';
export {
  getHookByToken,
  type Hook,
  type ResumedHook,
  resumeHook,
  resumeWebhook,
} from './runtime/resume-hook.js';
export {
  getRun,
  Run,
  type WorkflowReadableStream,
  type WorkflowReadableStreamOptions,
  type WorkflowRunWritableStreamOptions,
} from './runtime/run.js';
export {
  type CancelRunOptions,
  cancelRun,
  cancelRuns,
  listStreams,
  pendingWakeUpWaits,
  type ReadStreamOptions,
  type RecreateRunOptions,
  type ReenqueueRunOptions,
  readStream,
  recreateRunFromExisting,
  reenqueueRun,
  type StopSleepOptions,
  type StopSleepResult,
  wakeUpRun,
} from './runtime/runs.js';
export {
  type DynamicStartOptions,
  type DynamicWorkflowOptions,
  type DynamicWorkflowStepReference,
  type StartHookOptions,
  type StartOptions,
  type StartOptionsBase,
  type StartOptionsWithDeploymentId,
  type StartOptionsWithoutDeploymentId,
  start,
} from './runtime/start.js';
export {
  createWorld,
  createWorldFromModule,
  getWorld,
  getWorldHandlers,
  setWorld,
  type WorldFactoryModule,
} from './runtime/world.js';
