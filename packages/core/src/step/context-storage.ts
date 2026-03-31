import { AsyncLocalStorage } from 'node:async_hooks';
import type { CryptoKey } from '../encryption.js';
import { WORKFLOW_HAS_STEP_CONTEXT } from '../symbols.js';
import type { WorkflowMetadata } from '../workflow/get-workflow-metadata.js';
import type { StepMetadata } from './get-step-metadata.js';

export const contextStorage = /* @__PURE__ */ new AsyncLocalStorage<{
  stepMetadata: StepMetadata;
  workflowMetadata: WorkflowMetadata;
  ops: Promise<void>[];
  closureVars?: Record<string, any>;
  encryptionKey?: CryptoKey;
}>();

(globalThis as any)[WORKFLOW_HAS_STEP_CONTEXT] = () =>
  contextStorage.getStore() !== undefined;
