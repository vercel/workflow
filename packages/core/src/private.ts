/**
 * Utils used by the bundler when transforming code
 */

import type { CryptoKey } from './encryption.js';
import type { EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';
import type { Serializable } from './schemas.js';

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
  /**
   * In-flight buffered hook payload deliveries, keyed by the source
   * `hook_received` eventId. The value resolves once that delivery has
   * been observed by its consumer (see below).
   *
   * A buffered hook payload (received before the workflow awaited the
   * hook) resolves through a `ctx.promiseQueue` slot chained at its
   * log position, but the workflow only observes it via the async hook
   * iterator (`yield await this`), which adds microtask hops. A
   * competing `wait_completed` resolves synchronously in its own slot
   * (no hydration, fewer hops), so without coordination it can preempt
   * an earlier-in-log hook payload in a `Promise.race` — diverging from
   * the committed event log.
   *
   * Entities that resolve from a later log event (sleep) consult this
   * map via {@link awaitEarlierHookDeliveries} and defer behind any
   * delivery whose source eventId is earlier than their own event. The
   * barrier is a plain promise (not chained onto `promiseQueue`), so it
   * is decryption-time independent and cannot deadlock the serial queue.
   *
   * The barrier resolves on a MACROTASK after the payload is claimed by
   * its consumer (see hook.ts `markClaimed`). A macrotask runs only after
   * the full microtask queue has drained, so the consumer's branch
   * decision — however many await hops deep — always commits before a
   * deferring entity proceeds. This is hop-count independent. To avoid
   * deadlocking when a payload is never claimed (the workflow took a
   * different branch or is suspending), `awaitEarlierHookDeliveries`
   * bounds its wait with a one-macrotask fallback.
   */
  pendingHookDeliveries: Map<string, Promise<void>>;
}

/**
 * Awaits all in-flight buffered-hook payload deliveries whose source
 * `hook_received` event is earlier in the log than `eventId` (ULIDs sort
 * lexicographically by time, so a plain string compare is log order).
 * Lets a later entity (e.g. sleep's `wait_completed`) preserve event-log
 * resolution order against an earlier hook payload, independent of how
 * long that payload takes to hydrate/decrypt.
 */
export async function awaitEarlierHookDeliveries(
  ctx: WorkflowOrchestratorContext,
  eventId: string | undefined
): Promise<void> {
  // Defensive: tolerate contexts that predate this field (test harnesses).
  if (
    eventId === undefined ||
    !ctx.pendingHookDeliveries ||
    ctx.pendingHookDeliveries.size === 0
  ) {
    return;
  }
  const earlier: Promise<void>[] = [];
  for (const [sourceEventId, settled] of ctx.pendingHookDeliveries) {
    if (sourceEventId < eventId) {
      earlier.push(settled);
    }
  }
  if (earlier.length === 0) {
    return;
  }
  // Each barrier resolves when its hook payload's consumer has observed
  // it (a macrotask after the payload settles; see hook.ts `markClaimed`).
  // If a payload is never claimed — the workflow took a different branch
  // or is suspending — its barrier would otherwise never resolve and
  // deadlock this entity. Bound the wait with a macrotask fallback: a
  // claim that is going to happen resolves its barrier within one
  // macrotask of the payload settling, so racing the barriers against a
  // single `setTimeout(0)` either (a) lets the genuinely-claimed payload
  // win and commit its branch first, or (b) releases this entity once it
  // is clear no claim is pending. Either way the committed event-log
  // branch is honored and we cannot hang.
  await Promise.race([
    Promise.all(earlier),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    }),
  ]);
}

/**
 * Schedule a callback to fire only after all pending data deliveries
 * (step results, hook payloads) and async deserialization have completed.
 * Uses a polling loop: setTimeout(0) → check pendingDeliveries →
 * if > 0, wait for promiseQueue → repeat. This handles the multi-round
 * delivery pattern where each hook payload delivery cycle appends new
 * async work to the promiseQueue.
 */
export function scheduleWhenIdle(
  ctx: WorkflowOrchestratorContext,
  fn: () => void
): void {
  const check = () => {
    if (ctx.pendingDeliveries > 0) {
      // Still delivering data — wait for queue to drain, then re-check
      ctx.promiseQueue.then(() => {
        setTimeout(check, 0);
      });
    } else {
      fn();
    }
  };
  setTimeout(check, 0);
}
