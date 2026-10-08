const QUEUE_NAMESPACE_PATTERN = /^[a-z][a-z0-9]*$/;

function resolveQueueNamespace(namespace?: string): string | undefined {
  return namespace ?? process.env.WORKFLOW_QUEUE_NAMESPACE ?? undefined;
}

function getQueueTopicPrefix(namespace?: string, kind = 'workflow') {
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
 * Creates the queue trigger for background step-execution messages
 * (`__wkf_step_*`, or `__<namespace>_wkf_step_*`).
 *
 * `@workflow/world-vercel` sends a step's execution message to one shared
 * step topic per workflow instead of a per-step physical topic under the flow
 * trigger, so a fan-out's step messages go out in one batched request. The
 * trigger sets no `maxConcurrency`: a step has one message for its whole life
 * (retried in place, deduplicated by its idempotency key), so nothing on it
 * needs serializing, and a limit would serialize every step of the workflow.
 *
 * Register it on the same flow function as {@link getWorkflowQueueTrigger},
 * which handles both orchestration and step messages. The runtime only sends
 * to this topic when the generated route says the build registered it (see
 * {@link createWorkflowEntrypointOptionsCode}'s `stepTopic`).
 */
export function createWorkflowStepQueueTrigger(options?: {
  namespace?: string;
}) {
  const namespace = resolveQueueNamespace(options?.namespace);

  return {
    type: 'queue/v2beta' as const,
    topic: `${getQueueTopicPrefix(namespace, 'step')}*`,
    consumer: 'default',
    retryAfterSeconds: 5,
    initialDelaySeconds: 0,
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
  /**
   * The build registers the step-execution trigger
   * ({@link getWorkflowQueueTriggers}) on the flow function, so the runtime
   * may send step messages to the shared step topic.
   */
  stepTopic?: boolean;
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

  if (options?.stepTopic) {
    fields.push('stepTopic: true');
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
 * Returns the queue trigger configuration for workflow (flow) routes.
 *
 * Builds on `createWorkflowQueueTrigger()`: the namespace comes from
 * `options` or `WORKFLOW_QUEUE_NAMESPACE`, resolved at call time. Always sets
 * `maxConcurrency: 1`, so the queue processes at most one flow invocation per
 * concrete topic at a time. Paired with the per-run physical topic naming in
 * `@workflow/world-vercel` (which appends the run id to the flow topic, and
 * the step id for a step's message), this keeps a run to one orchestrator
 * invocation at a time while its queued steps run in parallel. Queued step
 * invocations share this flow trigger rather than using a separate route.
 *
 * Integrations that write their own flow trigger config instead of calling
 * this must set `maxConcurrency: 1` themselves.
 */
export function getWorkflowQueueTrigger(options?: { namespace?: string }) {
  return {
    ...createWorkflowQueueTrigger(options),
    maxConcurrency: 1,
  };
}

/**
 * Every queue trigger the flow function registers on Vercel: the flow trigger
 * ({@link getWorkflowQueueTrigger}) and the step-execution trigger
 * ({@link createWorkflowStepQueueTrigger}). A builder that registers both
 * reports it through `BaseBuilder.registersStepQueueTrigger`, which turns on
 * the shared step topic in the generated route.
 */
export function getWorkflowQueueTriggers(options?: { namespace?: string }) {
  return [
    getWorkflowQueueTrigger(options),
    createWorkflowStepQueueTrigger(options),
  ];
}
