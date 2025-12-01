/**
 * Worker exports for browser workflows.
 */

export { executeWorkflow, createStepRunner } from './engine.js';
export {
  setWorkflowRegistry,
  getWorkflowRegistry,
  type WorkflowFunction,
  type WorkflowRegistry,
} from './registry.js';
export * from './message-types.js';

// Note: shared-worker.ts contains side effects (self.onconnect) and should NOT
// be re-exported here. It's only used when running as an actual SharedWorker.
