const QUEUE_NAMESPACE_PATTERN = /^[a-z][a-z0-9]*$/;

function resolveQueueNamespace(namespace?: string): string | undefined {
  return namespace ?? process.env.WORKFLOW_QUEUE_NAMESPACE ?? undefined;
}

/**
 * The physical topic prefix of the flow route's queue trigger. `workflow`
 * (`__wkf_workflow_`) is the `maxConcurrency: 1` consumer, `keyed`
 * (`__wkf_keyed_`) the consumer of messages carrying a VQS concurrency key,
 * which VQS refuses on a topic a `maxConcurrency` consumer subscribes to.
 * `@workflow/world-vercel` picks between them per message.
 */
function getQueueTopicPrefix(
  namespace?: string,
  kind: 'workflow' | 'keyed' = 'workflow'
) {
  if (namespace !== undefined) {
    if (!QUEUE_NAMESPACE_PATTERN.test(namespace)) {
      throw new Error(
        `Invalid queue namespace "${namespace}": must be lowercase alphanumeric, starting with a letter`
      );
    }

    return `__${namespace}_wkf_${kind}_`;
  }

  return `__wkf_${kind}_`;
}

/**
 * Creates a queue trigger configuration for the workflow handler.
 * Handles both workflow orchestration and step execution on the same route.
 * Background steps are queued back to the workflow topic with a stepId.
 *
 * When `namespace` is provided, the trigger topic is scoped to avoid
 * collisions with other frameworks or direct Workflow SDK usage in the
 * same deployment.
 *
 * @example
 * // default: topic = '__wkf_workflow_*'
 * createWorkflowQueueTrigger()
 *
 * @example
 * // namespaced: topic = '__custom_wkf_workflow_*'
 * createWorkflowQueueTrigger({ namespace: 'custom' })
 */
export function createWorkflowQueueTrigger(options?: { namespace?: string }) {
  const namespace = resolveQueueNamespace(options?.namespace);

  return {
    type: 'queue/v2beta' as const,
    topic: `${getQueueTopicPrefix(namespace)}*`,
    consumer: 'default',
    retryAfterSeconds: 5, // Delay between retries (default: 60)
    initialDelaySeconds: 0, // Initial delay before first delivery (default: 0)
  };
}

/**
 * Creates the optional second argument for generated `workflowEntrypoint()`
 * calls. The namespace is resolved while building so generated route files do
 * not need `WORKFLOW_QUEUE_NAMESPACE` at runtime.
 */
export function createWorkflowEntrypointOptionsCode(options?: {
  namespace?: string;
  basePath?: string;
  /** Raw code identifier/expression emitted into generated route files, not data. */
  routeModuleBodyStartedAt?: string;
}) {
  const namespace = resolveQueueNamespace(options?.namespace);
  const fields: string[] = [];

  if (namespace) {
    // Reuse prefix construction for namespace validation.
    getQueueTopicPrefix(namespace);
    fields.push(`namespace: ${JSON.stringify(namespace)}`);
  }

  if (options?.basePath !== undefined) {
    fields.push(`basePath: ${JSON.stringify(options.basePath)}`);
  }

  if (options?.routeModuleBodyStartedAt) {
    fields.push(
      `routeModuleBodyStartedAt: ${options.routeModuleBodyStartedAt}`
    );
  }

  if (fields.length === 0) {
    return '';
  }

  return `, { ${fields.join(', ')} }`;
}

export function createWorkflowRouteHandlersCode(
  workflowEntrypointCall: string
) {
  return `export const POST = ${workflowEntrypointCall};
export const GET = POST;
export const HEAD = POST;
export const OPTIONS = POST;`;
}

/**
 * Default queue trigger (no namespace). Backward compatible.
 */
export const WORKFLOW_QUEUE_TRIGGER = createWorkflowQueueTrigger();

/**
 * Whether sequential replays are enabled. Always `true`: every run's
 * orchestrator deliveries go to a per-run topic consumed one at a time, and
 * the `WORKFLOW_SEQUENTIAL_REPLAYS` variable that used to gate this is no
 * longer read.
 *
 * @deprecated Kept so integrations that mirrored the old conditional keep
 * emitting `maxConcurrency: 1`. Call {@link getWorkflowQueueTrigger} instead.
 */
export function isSequentialReplaysEnabled(): boolean {
  return true;
}

/**
 * Returns the `maxConcurrency: 1` queue trigger of workflow (flow) routes.
 * Flow routes need {@link getWorkflowQueueTriggers}, which includes it.
 *
 * Builds on `createWorkflowQueueTrigger()`: the namespace comes from
 * `options` or `WORKFLOW_QUEUE_NAMESPACE`, resolved at call time. Always sets
 * `maxConcurrency: 1`, so the queue processes at most one flow invocation per
 * concrete topic at a time. Paired with the per-run physical topic naming in
 * `@workflow/world-vercel` (which appends the run id to the flow topic, and
 * the step id for a step's message), this keeps a spec-8 run to one
 * orchestrator invocation at a time while its queued steps run in parallel.
 * Queued step invocations share this flow trigger rather than using a
 * separate route.
 */
export function getWorkflowQueueTrigger(options?: { namespace?: string }) {
  return {
    ...createWorkflowQueueTrigger(options),
    maxConcurrency: 1,
  };
}

/**
 * Returns the queue trigger for the keyed flow topic
 * (`__wkf_keyed_*`, or `__<namespace>_wkf_keyed_*`).
 *
 * `@workflow/world-vercel` sends a spec-9 run's messages there. Its
 * orchestrator messages carry the run id as a VQS concurrency key, which keeps
 * the run to one orchestrator invocation at a time and coalesces the run's
 * other orchestrator messages into it; its step messages carry none and run
 * in parallel. The trigger has no `maxConcurrency`: VQS refuses a keyed send
 * to a topic a `maxConcurrency` consumer subscribes to.
 */
export function getKeyedWorkflowQueueTrigger(options?: { namespace?: string }) {
  const namespace = resolveQueueNamespace(options?.namespace);
  return {
    ...createWorkflowQueueTrigger(options),
    topic: `${getQueueTopicPrefix(namespace, 'keyed')}*`,
  };
}

/**
 * Returns every queue trigger a workflow (flow) route needs:
 * {@link getWorkflowQueueTrigger} for spec-8 runs, health checks and other
 * messages, and {@link getKeyedWorkflowQueueTrigger} for spec-9 runs.
 *
 * Integrations that write their own flow trigger config instead of calling
 * this must emit both, with `maxConcurrency: 1` on the first and none on the
 * second.
 */
export function getWorkflowQueueTriggers(options?: { namespace?: string }) {
  return [
    getWorkflowQueueTrigger(options),
    getKeyedWorkflowQueueTrigger(options),
  ];
}
