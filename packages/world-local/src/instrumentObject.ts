/**
 * Utility to instrument object methods with tracing.
 * This mirrors world-vercel's implementation for consistent observability.
 */
import { trace } from './telemetry.js';

/**
 * Wraps all methods of an object with tracing spans.
 * @param prefix - Prefix for span names (e.g., "world.runs")
 * @param o - Object with methods to instrument
 * @returns Instrumented object with same interface
 */
export function instrumentObject<T extends object>(prefix: string, o: T): T {
  const handlers = {} as T;
  for (const key of Object.keys(o) as (keyof T)[]) {
    if (typeof o[key] !== 'function') {
      handlers[key] = o[key];
    } else {
      const f = o[key];
      // @ts-expect-error - dynamic function wrapping
      handlers[key] = async (...args: unknown[]) =>
        trace(`${prefix}.${String(key)}`, {}, () => f(...args));
    }
  }
  return handlers;
}
