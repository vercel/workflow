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
  /**
   * Root run id of the current run's lineage (`$rootRunId`), so a nested
   * `start()` inherits it without reloading the parent. Set by the runtime from
   * the run it already has loaded.
   */
  rootRunId?: string;
  ops: Promise<void>[];
  /**
   * Operations that MUST be durably committed before the step's
   * `step_completed`/`step_failed` event is written, because the workflow
   * continuation triggered by that event depends on them.
   *
   * The canonical case is a step-initiated `AbortController.abort()`: the
   * durable `hook_received` event records the cancellation in the workflow's
   * event log. If it is flushed in the background (like `ops`), the workflow
   * continuation enqueued by `step_completed` can run — and advance past the
   * abort, dispatching a later step with a stale, non-aborted `signal` — before
   * the `hook_received` event exists. Awaiting these inline before completion
   * guarantees the abort is ordered ahead of any continuation that observes the
   * step's result. Unlike these, `ops` holds best-effort real-time stream
   * writes that should fire ASAP and are intentionally left in the background.
   *
   * Contract: producers MUST NOT push a promise that can reject — these are
   * awaited only to enforce ordering, never to surface an outcome. A rejection
   * here would propagate as an infra error (queue re-delivery), not the
   * user-code failure path, so each producer swallows its own errors (see
   * `reviveAbortController` in serialization.ts). The await sites also
   * defensively `.catch()` so ordering is all this bucket can ever enforce.
   *
   * Required (not optional) so a new step-context construction site that
   * forgets to wire it fails at compile time, rather than silently regressing
   * the ordering guarantee back to background-flush behavior.
   */
  preCompletionOps: Promise<void>[];
  closureVars?: Record<string, any>;
  encryptionKey?: CryptoKey;
  writables?: Map<string, CachedWritable>;
  /**
   * Turbo mode only: a promise that resolves once the backgrounded
   * `run_started` has landed (the run exists). Set when the step body runs
   * optimistically — before `run_started`/`step_started` are confirmed — so a
   * direct step-body world write (e.g. `setAttributes`, which
   * resolves to a host-side `attr_set` create) can gate on it and never race
   * ahead of the run's creation. `undefined` outside turbo and on the await
   * path, where `run_started` was already durable before the body ran.
   */
  runReadyBarrier?: Promise<unknown>;
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
