/**
 * The queue's clock: when a message becomes visible, and when a lease
 * lapses. Its own module so tests can replace it (`vi.mock`) with a clock
 * that runs fast, instead of waiting out real backoffs.
 */
export function queueNow(): number {
  return Date.now();
}
