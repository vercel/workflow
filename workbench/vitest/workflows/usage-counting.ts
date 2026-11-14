import { getStepMetadata, RetryableError } from 'workflow';

/** Fails its first two attempts, so it writes two retries. */
export async function flakyCharge(orderId: string) {
  'use step';
  const { attempt } = getStepMetadata();
  if (attempt <= 2) {
    throw new RetryableError(`attempt ${attempt} failed`, { retryAfter: 1 });
  }
  return `charged ${orderId}`;
}

export async function sendEmail(to: string) {
  'use step';
  return `sent to ${to}`;
}

/**
 * The shapes a run's step event count depends on: a retried step, and a
 * fan-out wider than the inline limit (WORKFLOW_MAX_INLINE_STEPS, 3 by
 * default), so some calls run inline and the rest go to the queue.
 */
export async function usageCountingWorkflow(orderId: string) {
  'use workflow';
  const charged = await flakyCharge(orderId);
  const sent = await Promise.all(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((to) => sendEmail(`${to}@example.com`))
  );
  return { charged, sent: sent.length };
}
