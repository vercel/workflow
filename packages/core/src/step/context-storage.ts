import { AsyncLocalStorage } from 'node:async_hooks';
import type { CryptoKey } from '../encryption.js';
import type { WorkflowMetadata } from '../workflow/get-workflow-metadata.js';
import type { StepMetadata } from './get-step-metadata.js';

export type StepContext = {
  stepMetadata: StepMetadata;
  workflowMetadata: WorkflowMetadata;
  ops: Promise<void>[];
  closureVars?: Record<string, any>;
  encryptionKey?: CryptoKey;
};

/**
 * Process-wide singleton AsyncLocalStorage for step execution context.
 *
 * Uses `Symbol.for()` on globalThis to guarantee a single instance even when
 * bundlers (e.g. Vercel's production bundler) create multiple copies of this
 * module. Without this, `contextStorage.run()` in the step handler and
 * `contextStorage.getStore()` in user code (via getWorkflowMetadata /
 * getStepMetadata) can reference different AsyncLocalStorage instances,
 * causing the store to appear empty.
 *
 * Note that we were unable to reproduce this issue. This is a fix for the only synthetic way
 * way in which we could get the builder to break with the reported error message, and
 * serves as defense-in-depth, since the change is otherwise safe.
 *
 * See: https://github.com/vercel/workflow/issues/1577
 */
const CONTEXT_STORAGE_SYMBOL = Symbol.for('WORKFLOW_STEP_CONTEXT_STORAGE');

export const contextStorage: AsyncLocalStorage<StepContext> =
  ((globalThis as any)[CONTEXT_STORAGE_SYMBOL] as
    | AsyncLocalStorage<StepContext>
    | undefined) ??
  ((globalThis as any)[CONTEXT_STORAGE_SYMBOL] =
    new AsyncLocalStorage<StepContext>());
