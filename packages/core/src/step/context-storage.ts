import { AsyncLocalStorage } from 'node:async_hooks';
import type { CryptoKey } from '../encryption.js';
import type { FlushableStreamState } from '../flushable-stream.js';
import type { WorkflowMetadata } from '../workflow/get-workflow-metadata.js';
import type { StepMetadata } from './get-step-metadata.js';

/**
 * Per-step cache entry for a `(runId, namespace)` writable stream.
 *
 * Holds the user-facing `WritableStream` and the shared `FlushableStreamState`
 * driving the background pipe to the workflow server. Re-used so repeat calls
 * to `getWritable()` within the same step return the same handle instead of
 * spawning racing pipes — see https://github.com/vercel/workflow/issues/2058.
 */
export interface CachedWritable {
  writable: WritableStream<any>;
  state: FlushableStreamState;
}

export type StepContext = {
  stepMetadata: StepMetadata;
  workflowMetadata: WorkflowMetadata;
  /** Deployment that owns the current workflow run, used for forwarded streams. */
  workflowDeploymentId?: string;
  ops: Promise<void>[];
  closureVars?: Record<string, any>;
  encryptionKey?: CryptoKey;
  writables?: Map<string, CachedWritable>;
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
