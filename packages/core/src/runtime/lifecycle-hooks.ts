import { WorkflowRunFailedError } from '@workflow/errors';
import { runtimeLogger } from '../logger.js';
import { dehydrateRunError, hydrateRunError } from '../serialization.js';
import { Run } from './run.js';
import { safeWaitUntil } from './wait-until.js';

/**
 * Parameters passed to an {@link WorkflowLifecycleHooks.onRunCompleted}
 * handler.
 */
export interface RunCompletedHookParams {
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
  /**
   * The failed run. The instance hydrates lazily, so accessors fetch from
   * the backend only when the handler actually uses them.
   */
  run: Run<unknown>;
  /**
   * The failure, in the same shape `run.returnValue` rejects with: a
   * `WorkflowRunFailedError` whose `errorCode` carries the failure
   * classification (e.g. `USER_ERROR`, `RUNTIME_ERROR`) and whose `cause` is
   * the hydrated thrown value (original Error subclass identity preserved).
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
 * shares one list — same pattern as the cross-realm error-class registry in
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
 * centralized reporting — e.g. forwarding failed runs to Sentry — without
 * wrapping every workflow body.
 *
 * Register early in the process lifecycle so handlers exist before the first
 * run finishes: in Next.js, `instrumentation.ts` is the natural place; in any
 * other app, any module that loads at startup works.
 *
 * Semantics:
 * - Handlers run on the host (full Node.js), never inside the workflow VM.
 * - Handlers fire only on the invocation that actually wrote the terminal
 *   event. Transitions recorded elsewhere — e.g. a run cancelled from the
 *   CLI or dashboard — do not fire handlers in the app.
 * - Handlers are fire-and-forget: they cannot delay or change the run's
 *   outcome, and a throwing handler is logged and swallowed. On serverless
 *   platforms the invocation is kept alive via `waitUntil`.
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
  event: 'onRunCompleted' | 'onRunFailed',
  prepare: () => Promise<TParams>,
  invoke: (
    hooks: WorkflowLifecycleHooks,
    params: TParams
  ) => void | Promise<void> | undefined
): void {
  // Snapshot so an unregister inside a handler cannot skew iteration.
  const registered = [...getRegistry()];
  if (registered.length === 0) {
    return;
  }
  safeWaitUntil(
    (async () => {
      const params = await prepare();
      for (const hooks of registered) {
        try {
          await invoke(hooks, params);
        } catch (err) {
          runtimeLogger.error(`Workflow lifecycle ${event} handler threw`, {
            workflowRunId: runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })(),
    // Covers a `prepare()` rejection; handler failures are caught above.
    (err) => {
      runtimeLogger.error(`Workflow lifecycle ${event} dispatch failed`, {
        workflowRunId: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  );
}

/**
 * Called by the runtime after it successfully wrote a `run_completed` event.
 * Never throws.
 */
export function dispatchRunCompletedHooks(runId: string): void {
  dispatch(
    runId,
    'onRunCompleted',
    async () => ({ run: new Run(runId) }),
    (hooks, params) => hooks.onRunCompleted?.(params)
  );
}

/**
 * The thrown value a `run_failed` writer holds is often a VM-realm object
 * (the workflow runs in a separate realm, so `instanceof Error` on it is
 * `false` for handlers) and may carry VM-realm exotics in its cause chain.
 * Round-trip it through the run-error serialization pipeline so handlers
 * receive the same host-realm hydrated shape `run.returnValue` rejects with
 * — real host Error instances with name/message/stack/cause preserved and
 * registered classes (FatalError, custom serde classes) revived with their
 * class identity. No encryption: the bytes never leave this process.
 *
 * Falls back to the original value when the round-trip fails — a degraded
 * report beats no report.
 */
async function hydrateForHandlers(
  error: unknown,
  runId: string
): Promise<unknown> {
  try {
    const bytes = await dehydrateRunError(error, runId, undefined);
    return await hydrateRunError(bytes, runId, undefined);
  } catch {
    return error;
  }
}

/**
 * Called by the runtime after it successfully wrote a `run_failed` event.
 * Never throws.
 *
 * @param error - The thrown value the terminal write recorded (host-side
 * object where available; QuickJS passes its rehydrated reconstruction).
 * @param errorCode - The classification written to the event's `errorCode`.
 */
export function dispatchRunFailedHooks(
  runId: string,
  error: unknown,
  errorCode: string
): void {
  dispatch(
    runId,
    'onRunFailed',
    async () => ({
      run: new Run(runId),
      error: new WorkflowRunFailedError(
        runId,
        await hydrateForHandlers(error, runId),
        { errorCode }
      ),
    }),
    (hooks, params) => hooks.onRunFailed?.(params)
  );
}
