/**
 * This is the "standard library" of steps that we make available to all workflow users.
 * The can be imported like so: `import { sleep, fetch } from 'workflow'`. and used in workflow.
 * The need to be exported directly in this package and cannot live in `core` to prevent
 * circular dependencies post-compilation.
 */

import { RetryableError } from '@workflow/errors';
import ms, { type StringValue } from 'ms';
import { getStepMetadata } from './index.js';

// vqs has a max message visibility lifespan, the workflow sleep function
// will retry repeatedly until the user requested duration is reached.
// (Eventually make this configurable based on the queue backend adapter)
const MAX_SLEEP_DURATION_SECONDS = ms('23h') / 1000;

/**
 * Sleep within a workflow for a given duration.
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
 * @param date - The date to sleep until, this must be a future date.
 * @overload
 * @returns A promise that resolves when the sleep is complete.
 */
export async function sleep(date: Date): Promise<void>;

export async function sleep(param: StringValue | Date): Promise<void> {
  'use step';
  const { stepStartedAt } = getStepMetadata();
  const durationMs =
    typeof param === 'string'
      ? ms(param)
      : param.getTime() - Number(stepStartedAt);

  if (typeof durationMs !== 'number' || durationMs < 0) {
    const message =
      param instanceof Date
        ? `Invalid sleep date: "${param}". Expected a future date.`
        : `Invalid sleep duration: "${param}". Expected a valid duration string like "1s", "1m", "1h", etc.`;
    throw new Error(message);
  }

  const endAt = +stepStartedAt + durationMs;
  const now = Date.now();
  if (now < endAt) {
    const remainingSeconds = (endAt - now) / 1000;
    const retryAfter = Math.min(remainingSeconds, MAX_SLEEP_DURATION_SECONDS);
    throw new RetryableError(
      `Sleeping for ${ms(retryAfter * 1000, { long: true })}`,
      {
        retryAfter,
      }
    );
  }
}
sleep.maxRetries = Infinity;

/**
 * A hoisted `fetch()` function that is executed as a "step" function,
 * for use within workflow functions.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
 */
export async function fetch(...args: Parameters<typeof globalThis.fetch>) {
  'use step';
  return globalThis.fetch(...args);
}
