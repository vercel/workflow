/**
 * Utility to instrument object methods with tracing.
 * This is a minimal version for world-vercel to avoid circular dependencies with @workflow/core.
 */
import { trace } from './telemetry.js';

/**
 * Wraps all methods of an object with tracing spans.
 * @param prefix - Prefix for span names (e.g., "WORLD.runs")
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
      // @ts-expect-error
      handlers[key] = async (...args: any[]) =>
        trace(`${prefix}.${String(key)}`, {}, () => f(...args));
    }
  }
  return handlers;
}
