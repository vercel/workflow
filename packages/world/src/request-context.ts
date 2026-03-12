import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * World-agnostic request context for cross-cutting concerns.
 *
 * This context is set by the core runtime (workflow/step queue handlers)
 * and read by World implementations to apply per-request behavior.
 *
 * Each World implementation interprets the context in its own way:
 * - `world-vercel`: Adds HTTP headers and routes to the chaos server
 * - `world-local`: Could inject filesystem/queue failures
 * - `world-postgres`: Could inject query failures
 */
export interface RequestContext {
  /**
   * Chaos testing mode identifier.
   *
   * When set, the World implementation should apply chaos behavior
   * appropriate for its transport/storage mechanism.
   *
   * Examples: "random-500", "random-429", "slow-response:3000"
   */
  chaos?: string;

  /**
   * Deterministic seed for reproducible chaos behavior.
   *
   * When set, chaos failures should be deterministic for the given seed,
   * making test failures reproducible in CI.
   */
  chaosSeed?: string;
}

/**
 * AsyncLocalStorage instance for per-request context propagation.
 *
 * The core runtime enters this context when processing queue messages
 * (both workflow and step handlers). World implementations read it
 * to apply per-request behavior like chaos testing.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Read the current request context, if any.
 *
 * Returns `undefined` when called outside of a `requestContext.run()` block.
 * The runtime only enters `requestContext.run()` when chaos config is present,
 * so a non-undefined return value indicates chaos testing is active.
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
