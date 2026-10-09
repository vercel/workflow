/** Seconds in a day. */
const DAY_SECONDS = 24 * 60 * 60;

/**
 * The most a step message may live, retries included. Vercel Queues caps
 * retention at 7 days.
 */
export const MAX_STEP_MESSAGE_RETENTION_SECONDS = 7 * DAY_SECONDS;

/**
 * Time a step's last retry must leave before its message expires: room for
 * the last attempt's body plus the redelivery delay a queue may add.
 */
export const STEP_RETRY_EXPIRY_SLACK_SECONDS = 30 * 60;

/**
 * Retention for a step's message, in seconds.
 *
 * A step keeps one message for its whole life, so the message has to outlive
 * every retry. The runtime cannot know the span ahead of time (a
 * `RetryableError` names its own `retryAfter`), so a step that may retry gets
 * the queue's maximum, and a step that never retries gets one day.
 * {@link retryOutlivesMessage} covers a span that exceeds even the maximum.
 */
export function stepMessageRetentionSeconds(maxRetries: number): number {
  return maxRetries > 0 ? MAX_STEP_MESSAGE_RETENTION_SECONDS : DAY_SECONDS;
}

/**
 * Whether a retry at `retryAtMs` would land after the step's message expires.
 * The step is then failed instead of retried, since a message that expires
 * before its retry strands the step with no outcome.
 *
 * Unknown `createdAt` (a World that does not report it) answers false.
 */
export function retryOutlivesMessage(params: {
  messageCreatedAt: Date | undefined;
  retentionSeconds: number;
  retryAtMs: number;
}): boolean {
  const { messageCreatedAt, retentionSeconds, retryAtMs } = params;
  if (!messageCreatedAt) return false;
  const expiresAtMs =
    messageCreatedAt.getTime() +
    (retentionSeconds - STEP_RETRY_EXPIRY_SLACK_SECONDS) * 1000;
  return retryAtMs > expiresAtMs;
}
