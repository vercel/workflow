import { AsyncLocalStorage } from 'node:async_hooks';
import type { CryptoKey } from '../encryption.js';
import type { WorkflowMetadata } from '../workflow/get-workflow-metadata.js';
import type { StepMetadata } from './get-step-metadata.js';

// Use a globalThis singleton so the context storage survives esbuild's
// module scope duplication (same pattern as the step registry in private.ts).
const CONTEXT_STORAGE = Symbol.for('@workflow/core//step-context-storage');

type StepContext = {
  stepMetadata: StepMetadata;
  workflowMetadata: WorkflowMetadata;
  ops: Promise<void>[];
  closureVars?: Record<string, any>;
  encryptionKey?: CryptoKey;
};

const _global: typeof globalThis & {
  [CONTEXT_STORAGE]?: AsyncLocalStorage<StepContext>;
} = globalThis;

if (!_global[CONTEXT_STORAGE]) {
  _global[CONTEXT_STORAGE] = new AsyncLocalStorage<StepContext>();
}

export const contextStorage = _global[CONTEXT_STORAGE];
