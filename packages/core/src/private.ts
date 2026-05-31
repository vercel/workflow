/**
 * Utils used by the bundler when transforming code
 */

import type { CryptoKey } from './encryption.js';
import type { EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';
import type { Serializable } from './schemas.js';

/**
 * Delay applied before firing WorkflowSuspension when this idle cycle has
 * observed in-flight replay deliveries. Inlined to 100ms on stable (the
 * `DEFERRED_CHECK_DELAY_MS` export from `events-consumer.ts` only exists on
 * 5.x). Conceptually mirrors that propagation guard.
 *
 * TODO: Replace this wall-clock heuristic with a deterministic counter that
 * tracks VM-resumption work in flight (e.g. promises waiting to cross the VM
 * boundary into the workflow context, plus any follow-up `subscribe()` calls
 * not yet registered). Once such a counter exists, `scheduleWhenIdle` can wait
 * on it directly instead of guessing how long propagation needs.
 */
const REPLAY_PROPAGATION_DELAY_MS = 100;

export type StepFunction<
  Args extends Serializable[] = any[],
  Result extends Serializable | unknown = unknown,
> = ((...args: Args) => Promise<Result>) & {
  maxRetries?: number;
  stepId?: string;
};

const RegisteredStepsKey = Symbol.for('@workflow/core//registeredSteps');

const globalSymbols: typeof globalThis & {
  [RegisteredStepsKey]?: Map<string, StepFunction>;
} = globalThis;

// biome-ignore lint/suspicious/noAssignInExpressions: /
const registeredSteps = (globalSymbols[RegisteredStepsKey] ??= new Map<
  string,
  StepFunction
>());

const BUILTIN_STEP_NAMES = new Set([
  '__builtin_response_array_buffer',
  '__builtin_response_json',
  '__builtin_response_text',
]);

function getStepIdAliasCandidates(stepId: string): string[] {
  const parts = stepId.split('//');
  if (parts.length !== 3 || parts[0] !== 'step') {
    return [];
  }

  const modulePath = parts[1];
  const fnName = parts[2];
  const modulePathAliases = new Set<string>();

  const addAlias = (aliasModulePath: string) => {
    if (aliasModulePath !== modulePath) {
      modulePathAliases.add(aliasModulePath);
    }
  };

  if (modulePath.startsWith('./workflows/')) {
    const workflowRelativePath = modulePath.slice('./'.length);
    addAlias(`./example/${workflowRelativePath}`);
    addAlias(`./src/${workflowRelativePath}`);
  } else if (modulePath.startsWith('./example/workflows/')) {
    const workflowRelativePath = modulePath.slice('./example/'.length);
    addAlias(`./${workflowRelativePath}`);
    addAlias(`./src/${workflowRelativePath}`);
  } else if (modulePath.startsWith('./src/workflows/')) {
    const workflowRelativePath = modulePath.slice('./src/'.length);
    addAlias(`./${workflowRelativePath}`);
    addAlias(`./example/${workflowRelativePath}`);
  }

  return Array.from(
    modulePathAliases,
    (aliasModulePath) => `step//${aliasModulePath}//${fnName}`
  );
}

function getBuiltinResponseStepAlias(stepId: string): StepFunction | undefined {
  if (!BUILTIN_STEP_NAMES.has(stepId)) {
    return undefined;
  }

  for (const [registeredStepId, stepFn] of registeredSteps.entries()) {
    if (registeredStepId.endsWith(`//${stepId}`)) {
      return stepFn;
    }
  }

  return undefined;
}

/**
 * Register a step function to be served in the server bundle.
 * Also sets the stepId property on the function for serialization support.
 */
export function registerStepFunction(stepId: string, stepFn: StepFunction) {
  registeredSteps.set(stepId, stepFn);
  stepFn.stepId = stepId;
}

/**
 * Find a registered step function by name
 */
export function getStepFunction(stepId: string): StepFunction | undefined {
  const directMatch = registeredSteps.get(stepId);
  if (directMatch) {
    return directMatch;
  }

  // Support equivalent workflow path aliases in mixed symlink environments.
  for (const aliasStepId of getStepIdAliasCandidates(stepId)) {
    const aliasMatch = registeredSteps.get(aliasStepId);
    if (aliasMatch) {
      return aliasMatch;
    }
  }

  const builtinAliasMatch = getBuiltinResponseStepAlias(stepId);
  if (builtinAliasMatch) {
    return builtinAliasMatch;
  }

  return undefined;
}

/**
 * Get closure variables for the current step function
 * @internal
 */
export { __private_getClosureVars } from './step/get-closure-vars.js';

export interface WorkflowOrchestratorContext {
  runId: string;
  encryptionKey: CryptoKey | undefined;
  globalThis: typeof globalThis;
  eventsConsumer: EventsConsumer;
  /**
   * Map of pending invocations keyed by correlationId.
   * Using Map instead of Array for O(1) lookup/delete operations.
   */
  invocationsQueue: Map<string, QueueItem>;
  onWorkflowError: (error: Error) => void;
  generateUlid: () => string;
  generateNanoid: () => string;
  /**
   * Sequential promise queue that ensures all event-driven promise resolutions
   * (step results, hook payloads, failures, suspensions) happen in event log
   * order. Every resolve, reject, or workflow error is chained through this
   * queue so that even if individual operations take variable time (e.g.,
   * async decryption), promises resolve deterministically.
   */
  promiseQueue: Promise<void>;
  /**
   * Counter of in-flight async data delivery operations (step result
   * hydration, hook payload hydration). Suspensions must wait for this
   * to reach 0 before firing, to avoid preempting data delivery.
   */
  pendingDeliveries: number;
}

/**
 * Schedule a callback to fire only after all pending data deliveries
 * (step results, hook payloads) and async deserialization have completed.
 * Uses a polling loop: setTimeout(0) → check pendingDeliveries →
 * if > 0, wait for promiseQueue → repeat.
 *
 * When pendingDeliveries reaches 0, do not fire immediately. Promise
 * resolutions can resume workflow code across the VM boundary and register
 * follow-up work after the host-side delivery has already decremented the
 * counter. Yield once, then re-drain promiseQueue before deciding the workflow
 * is truly idle.
 *
 * If this schedule cycle actually observed in-flight deliveries, add the same
 * small non-zero delay used by EventsConsumer before suspending. That preserves
 * the fast path for ordinary "new work needs to be scheduled" suspensions while
 * giving replay propagation enough time to register follow-up callbacks after
 * hydrated results cross the VM boundary.
 *
 * Unlike `EventsConsumer`'s deferred unconsumed-event check, this
 * propagation timer is not cancelled when a follow-up `useStep`/hook/sleep
 * registers during the wait. If a callback arrives mid-wait and consumes
 * the pending `*_created` event, the suspension still fires after the delay,
 * but it is harmless: the matching invocation already has
 * `hasCreatedEvent=true`, so the suspension handler will not re-create the
 * step, and the run simply continues replay from the persisted event log.
 */
export function scheduleWhenIdle(
  ctx: WorkflowOrchestratorContext,
  fn: () => void
): void {
  let sawPendingDeliveries = false;

  const fireWhenReady = () => {
    if (!sawPendingDeliveries) {
      fn();
      return;
    }

    setTimeout(() => {
      if (ctx.pendingDeliveries > 0) {
        // sawPendingDeliveries is already true on this branch (fireWhenReady's
        // early return covers the false case), so no need to re-assign here.
        ctx.promiseQueue.then(() => {
          setTimeout(check, 0);
        });
      } else {
        fn();
      }
    }, REPLAY_PROPAGATION_DELAY_MS);
  };

  const runWhenStillIdle = () => {
    ctx.promiseQueue
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      .then(() => ctx.promiseQueue)
      .then(() => {
        if (ctx.pendingDeliveries > 0) {
          sawPendingDeliveries = true;
          ctx.promiseQueue.then(() => {
            setTimeout(check, 0);
          });
        } else {
          fireWhenReady();
        }
      });
  };

  const check = () => {
    if (ctx.pendingDeliveries > 0) {
      sawPendingDeliveries = true;
      // Still delivering data — wait for queue to drain, then re-check
      ctx.promiseQueue.then(() => {
        setTimeout(check, 0);
      });
    } else {
      runWhenStillIdle();
    }
  };
  setTimeout(check, 0);
}
