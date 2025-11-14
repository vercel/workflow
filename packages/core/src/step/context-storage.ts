import { AsyncLocalStorage } from 'node:async_hooks';
import type { StreamOperationPromise } from '../serialization.js';
import type { WorkflowMetadata } from '../workflow/get-workflow-metadata.js';
import type { StepMetadata } from './get-step-metadata.js';

export const contextStorage = /* @__PURE__ */ new AsyncLocalStorage<{
  stepMetadata: StepMetadata;
  workflowMetadata: WorkflowMetadata;
  ops: StreamOperationPromise[];
}>();
