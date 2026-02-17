/**
 * Queue trigger configuration for workflow step execution.
 * Steps are queued to the __wkf_step_* topic.
 */
export const STEP_QUEUE_TRIGGER = {
  type: 'queue/v2beta' as const,
  topic: '__wkf_step_*',
  consumer: 'default',
  maxDeliveries: 64, // Maximum number of delivery attempts (default: 3)
  retryAfterSeconds: 5, // Delay between retries (default: 60)
  initialDelaySeconds: 0, // Initial delay before first delivery (default: 0)
};

/**
 * Queue trigger configuration for workflow orchestration.
 * Workflows are queued to the __wkf_workflow_* topic.
 */
export const WORKFLOW_QUEUE_TRIGGER = {
  type: 'queue/v2beta' as const,
  topic: '__wkf_workflow_*',
  consumer: 'default',
  maxDeliveries: 64, // Maximum number of delivery attempts (default: 3)
  retryAfterSeconds: 5, // Delay between retries (default: 60)
  initialDelaySeconds: 0, // Initial delay before first delivery (default: 0)
};
