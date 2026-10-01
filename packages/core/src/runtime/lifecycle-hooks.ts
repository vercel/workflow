import type { Span } from '@opentelemetry/api';
import { FatalError, WorkflowRunFailedError } from '@workflow/errors';
import { runtimeLogger } from '../logger.js';
import type { PayloadKey } from '../serialization/encryption.js';
import { hydrateRunError } from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { trace } from '../telemetry.js';
import { getErrorMessage, getErrorName, getErrorStack } from '../types.js';
import { Run } from './run.js';
import { safeWaitUntil } from './wait-until.js';

interface RunHookParams {
  /**
   * The machine-readable workflow identifier, such as
   * `workflow//./src/workflows/order//processOrder`, available without a read.
   * Unlike this string, `run.workflowName` is a Promise that fetches metadata.
   */
  workflowName: string;
  /**
   * The transitioned run. The instance hydrates lazily, so reading
   * `run.returnValue` (or any other accessor) fetches from the backend only
   * when the handler actually uses it.
   */
  run: Run<unknown>;
}

/** Parameters passed to an {@link WorkflowLifecycleHooks.onRunCompleted} handler. */
export type RunCompletedHookParams = RunHookParams;

/**
 * Parameters passed to an {@link WorkflowLifecycleHooks.onRunFailed}
 * handler.
 */
export interface RunFailedHookParams extends RunHookParams {
  /**
   * The persisted failure hydrated for reporting. Unlike `run.returnValue`,
   * readable streams load only when consumed and abort signals reflect their
   * persisted state without live subscriptions. Writable streams retain their
   * normal forwarding setup.
   *
   * This `WorkflowRunFailedError` has an `errorCode` carrying the failure
   * classification (e.g. `USER_ERROR`, `RUNTIME_ERROR`). Its `cause` is
   * the hydrated persisted value. Custom serializers can restore a registered
   * Error subclass, but module copies may have different constructors. Prefer
   * `.is()` guards and structural properties over `instanceof` in handlers.
   * If hydration fails, `cause` is a generic Error, matching
   * `run.returnValue`'s fallback.
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
 * copy of `@workflow/core` in the process (including separate bundler layers)
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
 * run finishes, in the host process that executes the workflow route. Next.js
 * on Vercel requires >= 16.3.0 to await `instrumentation.ts` registration.
 * Standalone Vercel workflow functions emitted by Nitro v2, Astro, Nest, and
 * the CLI do not load application startup modules; see the lifecycle guide
 * for supported framework registration points.
 *
 * Semantics:
 * - Register at host startup, never from a workflow or step function.
 *   Handlers run on the host (full Node.js), never inside the workflow VM.
 * - Handlers fire only on the invocation that actually wrote the terminal
 *   event. Transitions recorded elsewhere (e.g. a run cancelled from the
 *   CLI or dashboard) do not fire handlers in the app.
 * - Handlers are fire-and-forget: they cannot delay or change the run's
 *   outcome, and a throwing handler is logged and swallowed. On Vercel,
 *   `waitUntil` keeps the invocation alive for handlers and background stream
 *   operations from the hydrated failure. On other hosts handlers run
 *   detached, and freezing serverless hosts may not let them finish.
 * - Reporting is best effort: callbacks are not retried if the invocation
 *   dies before they finish. Use the event log as the system of record.
 * - Multiple registrations are allowed; handlers run in registration order.
 *   Registrations are not deduplicated. Unregister the previous hooks before
 *   registering again during hot reload or module re-evaluation.
 *
 * @returns A function that unregisters these hooks.
 */
export function registerLifecycleHooks(
  hooks: WorkflowLifecycleHooks
): () => void {
  if (contextStorage.getStore()) {
    throw new FatalError(
      'registerLifecycleHooks() cannot be called from a step function. ' +
        'Register at host startup, e.g. in instrumentation.ts for Next.js.'
    );
  }
  const registry = getRegistry();
  registry.push(hooks);
  return () => {
    const index = registry.indexOf(hooks);
    if (index !== -1) {
      registry.splice(index, 1);
    }
  };
}

function readErrorField(read: () => string, fallback: string): string {
  try {
    return read();
  } catch {
    return fallback;
  }
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
  prepare: (
    ops: Promise<void>[],
    logFailure: (what: string, err: unknown) => void
  ) => Promise<TParams>,
  invoke: (
    hooks: WorkflowLifecycleHooks,
    params: TParams
  ) => void | Promise<void> | undefined
): void {
  const logFailure = (what: string, err: unknown, span?: Span): void => {
    // Read fields independently: a hostile accessor or toString must not
    // discard the diagnostic or the other fields that are still readable.
    const fields = {
      errorName: readErrorField(() => getErrorName(err), 'Error'),
      errorMessage: readErrorField(() => getErrorMessage(err), '[unreadable]'),
      errorStack: readErrorField(() => getErrorStack(err), ''),
    };
    try {
      runtimeLogger.error(`Workflow lifecycle ${event} ${what}`, {
        workflowRunId: runId,
        workflowName,
        ...fields,
      });
    } catch {
      // Even error accessors and custom log sinks can throw. Reporting must
      // never affect a terminal write or prevent later handlers from running.
    }
    try {
      span?.addEvent('workflow.lifecycle.error', { phase: what, ...fields });
    } catch {
      // A broken log sink or tracer must not suppress the other diagnostic.
    }
  };

  try {
    // Snapshot before reading user-supplied properties: a getter may throw or
    // unregister hooks, just as a handler can.
    const registered = getRegistry()
      .slice()
      .filter((hooks) => {
        try {
          return Boolean(hooks[event]);
        } catch (err) {
          logFailure('handler property access threw', err);
          return false;
        }
      });
    if (registered.length === 0) return;

    safeWaitUntil(
      trace(
        `workflow.lifecycle.${event}`,
        {
          attributes: {
            ...Attribute.WorkflowRunId(runId),
            ...Attribute.WorkflowName(workflowName),
          },
        },
        async (span) => {
          const reportFailure = (what: string, err: unknown) =>
            logFailure(what, err, span);
          const ops: Promise<void>[] = [];
          try {
            const params = await prepare(ops, reportFailure);
            for (const hooks of registered) {
              try {
                await invoke(hooks, params);
              } catch (err) {
                reportFailure('handler threw', err);
              }
            }
          } finally {
            // Hydration and handlers can start background pipes. Keep all of
            // them alive, even if preparation, a handler, or another pipe fails.
            // Nested streams can append operations while a batch is draining.
            let drained = 0;
            while (drained < ops.length) {
              const batch = ops.slice(drained);
              drained = ops.length;
              const results = await Promise.allSettled(batch);
              for (const result of results) {
                if (result.status === 'rejected') {
                  reportFailure('stream operation failed', result.reason);
                }
              }
            }
          }
        }
      ),
      (err) => logFailure('dispatch failed', err)
    );
  } catch (err) {
    // Includes synchronous registry access and scheduling failures.
    logFailure('dispatch failed', err);
  }
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
 * serializers or reading streams a reporting handler may never consume.
 * Use the same fallback as `Run.returnValue` when the host cannot revive it.
 */
async function hydrateForHandlers(
  error: unknown,
  runId: string,
  encryptionKey: PayloadKey | undefined,
  ops: Promise<void>[],
  logFailure: (what: string, err: unknown) => void
): Promise<unknown> {
  try {
    return await hydrateRunError(
      error,
      runId,
      encryptionKey,
      ops,
      globalThis,
      undefined,
      {
        lazyStreams: true,
        liveAbortSignals: false,
      }
    );
  } catch (err) {
    logFailure('error hydration failed', err);
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
    async (ops, logFailure) => ({
      run: new Run(runId),
      workflowName,
      error: new WorkflowRunFailedError(
        runId,
        await hydrateForHandlers(error, runId, encryptionKey, ops, logFailure),
        { errorCode }
      ),
    }),
    (hooks, params) => hooks.onRunFailed?.(params)
  );
}
