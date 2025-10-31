import type { StringValue } from 'ms';
import { WORKFLOW_SLEEP } from './symbols.js';

/**
 * Sleep within a workflow for a given duration.
 *
 * This is a built-in runtime function that uses timer events in the event log.
 *
 * @param duration - The duration to sleep for, this is a string in the format
 * of `"1000ms"`, `"1s"`, `"1m"`, `"1h"`, or `"1d"`.
 * @overload
 * @returns A promise that resolves when the sleep is complete.
 */
export async function sleep(duration: StringValue): Promise<void>;

/**
 * Sleep within a workflow until a specific date.
 *
 * This is a built-in runtime function that uses timer events in the event log.
 *
 * @param date - The date to sleep until, this must be a future date.
 * @overload
 * @returns A promise that resolves when the sleep is complete.
 */
export async function sleep(date: Date): Promise<void>;

export async function sleep(param: StringValue | Date): Promise<void> {
  // Inside the workflow VM, the sleep function is stored in the globalThis object behind a symbol
  const sleepFn = (globalThis as any)[WORKFLOW_SLEEP];
  if (!sleepFn) {
    throw new Error('`sleep()` can only be called inside a workflow function');
  }
  return sleepFn(param);
}
