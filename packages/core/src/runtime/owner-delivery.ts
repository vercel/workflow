import { WorkflowWorldError } from '@workflow/errors';

/** Delivery failures do not establish whether the owner processed the input. */
export function isRetryableOwnerDelivery(error: unknown): boolean {
  if (!WorkflowWorldError.is(error)) return false;
  if ([400, 401, 403, 404, 410].includes(error.status ?? 0)) return false;
  return (
    [408, 429, 502, 503, 504].includes(error.status ?? 0) ||
    ['TRANSPORT', 'TIMEOUT', 'INVOCATION_OUTCOME_UNKNOWN'].includes(
      error.code ?? ''
    )
  );
}

/** Retry delivery, never the step body. The caller retains payload and identity. */
export async function retryOwnerDelivery<T>(
  deadline: number,
  deliver: (timeoutMs: number) => Promise<T>
): Promise<T> {
  let delay = 100;
  let lastError: unknown;
  for (;;) {
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
    // Equal jitter avoids synchronized retry waves without a zero-delay spin.
    await new Promise<void>((resolve) =>
      setTimeout(
        resolve,
        Math.min(
          Math.max(0, deadline - Date.now()),
          delay / 2 + (Math.random() * delay) / 2
        )
      )
    );
    delay = Math.min(2000, delay * 2);
  }
}
