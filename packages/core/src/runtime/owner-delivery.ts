import { WorkflowWorldError } from '@workflow/errors';

/** Delivery failures do not establish whether the owner processed the input. */
export function isRetryableOwnerDelivery(error: unknown): boolean {
  // Subclasses (for example a rehydrated conflict) carry the same fields.
  if (!(error instanceof Error) || !('status' in error || 'code' in error))
    return false;
  const { status = 0, code } = error as { status?: number; code?: string };
  // Any platform or transport 5xx (including affinity backoff 503 and a worker
  // invocation that failed before running) leaves the outcome unknown.
  return (
    status >= 500 ||
    [408, 429].includes(status) ||
    ['TRANSPORT', 'TIMEOUT', 'INVOCATION_OUTCOME_UNKNOWN'].includes(code ?? '')
  );
}

/** First wait after a failed delivery: 1 s plus up to 1 s of jitter. */
const FIRST_RETRY_MS = 1000;
const RETRY_JITTER_MS = 1000;
/** Longest wait between deliveries. */
const MAX_RETRY_MS = 120_000;

/**
 * Retry delivery, never the step body. The caller retains payload and identity.
 *
 * The first wait is 1 s plus up to 1 s of jitter (e.g. 1.4 s), then doubles
 * after every failure up to 120 s, until the deadline. A busy owner (its
 * affinity instance answering 503) therefore sees the retry rate of a large
 * fan-out fall instead of being refilled every couple of seconds.
 *
 * Future: after a shorter direct-retry window, hand the result to the queue
 * (VQS) and let this worker finish, instead of holding it until the deadline.
 */
export async function retryOwnerDelivery<T>(
  deadline: number,
  deliver: (timeoutMs: number) => Promise<T>,
  onRetry?: (failure: {
    attempt: number;
    error: unknown;
    retryInMs: number;
  }) => void
): Promise<T> {
  let delay = FIRST_RETRY_MS + Math.random() * RETRY_JITTER_MS;
  let lastError: unknown;
  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw (
        lastError ??
        new WorkflowWorldError('Step-result delivery deadline reached', {
          status: 408,
        })
      );
    try {
      return await deliver(Math.min(30_000, remaining));
    } catch (error) {
      if (!isRetryableOwnerDelivery(error)) throw error;
      lastError = error;
    }
    const retryInMs = Math.min(Math.max(0, deadline - Date.now()), delay);
    onRetry?.({ attempt, error: lastError, retryInMs });
    await new Promise<void>((resolve) => setTimeout(resolve, retryInMs));
    delay = Math.min(MAX_RETRY_MS, delay * 2);
  }
}
