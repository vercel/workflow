/**
 * Queue trigger configuration for the workflow handler.
 * Handles both workflow orchestration and step execution on the same route.
 * Background steps are queued back to __wkf_workflow_* with a stepId.
 */
export const WORKFLOW_QUEUE_TRIGGER = {
  type: 'queue/v2beta' as const,
  topic: '__wkf_workflow_*',
  consumer: 'default',
  retryAfterSeconds: 5, // Delay between retries (default: 60)
  initialDelaySeconds: 0, // Initial delay before first delivery (default: 0)
};
