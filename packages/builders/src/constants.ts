/**
 * Queue trigger configuration for workflow step execution.
 * Steps are queued to the __wkf_step_* topic.
 */
export const STEP_QUEUE_TRIGGER = {
  type: 'queue/v2beta' as const,
  topic: '__wkf_step_*',
  consumer: 'default',
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
  retryAfterSeconds: 5, // Delay between retries (default: 60)
  initialDelaySeconds: 0, // Initial delay before first delivery (default: 0)
};

/**
 * Returns the queue trigger configuration for workflow (flow) routes.
 *
 * When `ENFORCE_STRICT_CONCURRENCY` is enabled, sets `maxConcurrency: 1` so
 * VQS processes at most one flow invocation per concrete topic at a time.
 * Paired with the per-run physical topic naming in `@workflow/world-vercel`
 * (which appends the run id to the flow topic), this enforces at most one
 * orchestrator invocation per run. Step routes are intentionally excluded.
 *
 * Must be read at build time, where the env var gates what is written into
 * the route's `experimentalTriggers` config.
 */
export function getWorkflowQueueTrigger() {
  return {
    ...WORKFLOW_QUEUE_TRIGGER,
    ...(process.env.ENFORCE_STRICT_CONCURRENCY === '1' && {
      maxConcurrency: 1,
    }),
  };
}
