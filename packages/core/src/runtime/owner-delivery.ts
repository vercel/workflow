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

/** Result-delivery backoff: 1 s plus up to 1 s of jitter, doubling to 30 s.
 * Many workers of one fan-out may retry against the same owner at once. */
const FIRST_RETRY_MS = 1000;
const RETRY_JITTER_MS = 1000;
const MAX_RETRY_MS = 30_000;

/** Retry delivery, never the step body. The caller retains payload and identity. */
export async function retryOwnerDelivery<T>(
  deadline: number,
  deliver: (timeoutMs: number) => Promise<T>,
  onRetry?: (failure: {
    attempt: number;
    error: unknown;
    retryInMs: number;
  }) => void
): Promise<T> {
  let delay = FIRST_RETRY_MS;
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
    // Up to a second of jitter keeps a fan-out's workers from retrying in
    // lockstep; the doubling thins out the retries a blocked owner receives.
    const retryInMs = Math.min(
      Math.max(0, deadline - Date.now()),
      delay + Math.random() * RETRY_JITTER_MS
    );
    onRetry?.({ attempt, error: lastError, retryInMs });
    await new Promise<void>((resolve) => setTimeout(resolve, retryInMs));
    delay = Math.min(MAX_RETRY_MS, delay * 2);
  }
}
