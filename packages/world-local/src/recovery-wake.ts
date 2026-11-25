import { MAX_SAFE_TIMEOUT_MS } from './queue.js';

/**
 * The delay of a recovered wait's backstop wake, or `undefined` for none: a
 * wait due later than the queue's longest timer (`MAX_SAFE_TIMEOUT_MS`,
 * about 24.8 days) gets none. Its wake would fire early as a plain wake,
 * which a spec 9 run does not treat as a hop of the wait's chain, so it
 * would re-arm nothing; the run's recovery delivery arms that wait's chain.
 */
export function backstopWakeDelaySeconds(
  resumeAt: number,
  now: number
): number | undefined {
  const delayMs = Math.max(0, resumeAt - now);
  if (delayMs > MAX_SAFE_TIMEOUT_MS) return undefined;
  return Math.ceil(delayMs / 1000);
}
