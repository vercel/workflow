import { WorkflowRunFailedError } from '@workflow/errors';
import { runtimeLogger } from '../logger.js';
import type { PayloadKey } from '../serialization/encryption.js';
import { getExternalRevivers, hydrateRunError } from '../serialization.js';
import { trace } from '../telemetry.js';
import { getErrorName, getErrorStack } from '../types.js';
import { Run } from './run.js';
import { safeWaitUntil } from './wait-until.js';

/**
 * Parameters passed to an {@link WorkflowLifecycleHooks.onRunCompleted}
 * handler.
 */
export interface RunCompletedHookParams {
  /** The workflow name, available without fetching the run. */
  workflowName: string;
  /**
   * The completed run. The instance hydrates lazily, so reading
   * `run.returnValue` (or any other accessor) fetches from the backend only
   * when the handler actually uses it.
   */
  run: Run<unknown>;
}

/**
 * Parameters passed to an {@link WorkflowLifecycleHooks.onRunFailed}
 * handler.
 */
export interface RunFailedHookParams {
  /** The workflow name, available without fetching the run. */
  workflowName: string;
  /**
   * The failed run. The instance hydrates lazily, so accessors fetch from
   * the backend only when the handler actually uses them.
   */
  run: Run<unknown>;
  /**
   * The failure, in the same shape `run.returnValue` rejects with: a
   * `WorkflowRunFailedError` whose `errorCode` carries the failure
   * classification (e.g. `USER_ERROR`, `RUNTIME_ERROR`) and whose `cause` is
   * the hydrated persisted value (registered Error subclass identity preserved).
   * Streams are read only when consumed; abort signals reflect their persisted
   * state without live subscriptions. If hydration fails, `cause` is a generic
   * Error, matching `run.returnValue`'s fallback.
   */
  error: WorkflowRunFailedError;
}

/**
 * Global handlers observing workflow run lifecycle transitions. Register via
 * {@link registerLifecycleHooks}.
 */
export interface WorkflowLifecycleHooks {
  /** Invoked when a workflow run completes successfully. */
  onRunCompleted?: (params: RunCompletedHookParams) => void | Promise<void>;
  /** Invoked when a workflow run fails terminally (after any retries). */
  onRunFailed?: (params: RunFailedHookParams) => void | Promise<void>;
}

/**
 * The registry lives on `globalThis` under a `Symbol.for` key so that every
 * copy of `@workflow/core` in the process (bundled + unbundled, ESM + CJS)
 * shares one list, the same pattern as the cross-realm error-class registry in
 * `@workflow/errors` and the World cache in `get-world-lazy.ts`. The property
 * is non-writable/non-configurable so accidental clobbering is loud; the
 * array's contents stay mutable for register/unregister.
 */
const REGISTRY_KEY = Symbol.for('@workflow/core//lifecycleHooks');

function getRegistry(): WorkflowLifecycleHooks[] {
  if (!Object.hasOwn(globalThis, REGISTRY_KEY)) {
    Object.defineProperty(globalThis, REGISTRY_KEY, {
      value: [],
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  return (globalThis as Record<symbol, unknown>)[
    REGISTRY_KEY
  ] as WorkflowLifecycleHooks[];
}

/**
 * Registers global workflow lifecycle handlers, invoked by the runtime on
 * the compute that records a run's terminal transition. Useful for
 * centralized reporting (e.g. forwarding failed runs to Sentry) without
 * wrapping every workflow body.
 *
 * Register early in the process lifecycle so handlers exist before the first
 * run finishes: in Next.js, `instrumentation.ts` is the natural place; in any
 * other app, any module that loads at startup works.
 *
 * Semantics:
 * - Handlers run on the host (full Node.js), never inside the workflow VM.
 * - Handlers fire only on the invocation that actually wrote the terminal
 *   event. Transitions recorded elsewhere (e.g. a run cancelled from the
 *   CLI or dashboard) do not fire handlers in the app.
 * - Handlers are fire-and-forget: they cannot delay or change the run's
 *   outcome, and a throwing handler is logged and swallowed. On Vercel,
 *   `waitUntil` keeps the invocation alive. On other hosts handlers run
 *   detached, and freezing serverless hosts may not let them finish.
 * - Reporting is best effort: callbacks are not retried if the invocation
 *   dies before they finish. Use the event log as the system of record.
 * - Multiple registrations are allowed; handlers run in registration order.
 *
 * @returns A function that unregisters these hooks.
 */
export function registerLifecycleHooks(
  hooks: WorkflowLifecycleHooks
): () => void {
  const registry = getRegistry();
  registry.push(hooks);
  return () => {
    const index = registry.indexOf(hooks);
    if (index !== -1) {
      registry.splice(index, 1);
    }
  };
}

/**
 * Runs every registered handler for one lifecycle transition without ever
 * throwing into (or blocking) the runtime's terminal-write path: the work is
 * scheduled through `safeWaitUntil`, the params are prepared at most once
 * per transition, each handler's failure is logged and swallowed
 * individually, and handlers run sequentially in registration order.
 */
function dispatch<TParams>(
  runId: string,
  workflowName: string,
  event: 'onRunCompleted' | 'onRunFailed',
  prepare: () => Promise<TParams>,
  invoke: (
    hooks: WorkflowLifecycleHooks,
    params: TParams
  ) => void | Promise<void> | undefined
): void {
  // Snapshot so an unregister inside a handler cannot skew iteration.
  const registered = getRegistry().filter((hooks) => hooks[event]);
  if (registered.length === 0) {
    return;
  }
  safeWaitUntil(
    trace(`workflow.lifecycle.${event}`, async () => {
      const params = await prepare();
      for (const hooks of registered) {
        try {
          await invoke(hooks, params);
        } catch (err) {
          runtimeLogger.error(`Workflow lifecycle ${event} handler threw`, {
            workflowRunId: runId,
            workflowName,
            errorName: getErrorName(err),
            errorMessage: err instanceof Error ? err.message : String(err),
            errorStack: getErrorStack(err),
          });
        }
      }
    }),
    // Covers a `prepare()` rejection; handler failures are caught above.
    (err) => {
      runtimeLogger.error(`Workflow lifecycle ${event} dispatch failed`, {
        workflowRunId: runId,
        workflowName,
        errorName: getErrorName(err),
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: getErrorStack(err),
      });
    }
  );
}

/**
 * Called by the runtime after it successfully wrote a `run_completed` event.
 * Never throws.
 */
export function dispatchRunCompletedHooks(
  runId: string,
  workflowName: string
): void {
  dispatch(
    runId,
    workflowName,
    'onRunCompleted',
    async () => ({ run: new Run(runId), workflowName }),
    (hooks, params) => hooks.onRunCompleted?.(params)
  );
}

/**
 * Hydrate the exact error the terminal writer persisted, without re-running
 * serializers or opening streams a reporting handler may never consume.
 * Use the same fallback as `Run.returnValue` when the host cannot revive it.
 */
async function hydrateForHandlers(
  error: unknown,
  runId: string,
  encryptionKey: PayloadKey | undefined
): Promise<unknown> {
  try {
    const ops: Promise<void>[] = [];
    return await hydrateRunError(
      error,
      runId,
      encryptionKey,
      ops,
      globalThis,
      getExternalRevivers(globalThis, ops, runId, encryptionKey, {
        lazyStreams: true,
        liveAbortSignals: false,
      })
    );
  } catch {
    return new Error('Failed to hydrate workflow run error');
  }
}

/**
 * Called by the runtime after it successfully wrote a `run_failed` event.
 * Never throws.
 *
 * @param error - The serialized error payload stored by the terminal write.
 * @param errorCode - The classification written to the event's `errorCode`.
 */
export function dispatchRunFailedHooks(
  runId: string,
  workflowName: string,
  error: unknown,
  encryptionKey: PayloadKey | undefined,
  errorCode: string
): void {
  dispatch(
    runId,
    workflowName,
    'onRunFailed',
    async () => ({
      run: new Run(runId),
      workflowName,
      error: new WorkflowRunFailedError(
        runId,
        await hydrateForHandlers(error, runId, encryptionKey),
        { errorCode }
      ),
    }),
    (hooks, params) => hooks.onRunFailed?.(params)
  );
}
