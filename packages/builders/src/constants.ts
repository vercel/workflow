const QUEUE_NAMESPACE_PATTERN = /^[a-z][a-z0-9]*$/;

function resolveQueueNamespace(namespace?: string): string | undefined {
  return namespace ?? process.env.WORKFLOW_QUEUE_NAMESPACE ?? undefined;
}

function getQueueTopicPrefix(kind: 'workflow' | 'step', namespace?: string) {
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
    topic: `${getQueueTopicPrefix('workflow', namespace)}*`,
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
    getQueueTopicPrefix('workflow', namespace);
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
 * Returns the queue trigger configuration for workflow (flow) routes.
 *
 * Builds on `createWorkflowQueueTrigger()` — the namespace comes from
 * `options` or `WORKFLOW_QUEUE_NAMESPACE`, resolved at call time. When
 * `WORKFLOW_SEQUENTIAL_REPLAYS` is enabled, sets `maxConcurrency: 1` so the
 * queue processes at most one flow invocation per concrete topic at a time.
 * Paired with the per-run physical topic naming in `@workflow/world-vercel`
 * (which appends the run id to the flow topic), this enforces at most one
 * orchestrator invocation per run. Step routes are intentionally excluded.
 *
 * Integrations that write their own flow trigger config instead of calling
 * this must mirror the conditional `maxConcurrency: 1` themselves — the
 * runtime half (per-run topics) activates from the env var alone, and without
 * the trigger half those topics are not serialized.
 *
 * Must be read at build time, where the env var gates what is written into
 * the route's `experimentalTriggers` config.
 */
/**
 * Whether sequential replays are enabled: `WORKFLOW_SEQUENTIAL_REPLAYS=1`,
 * or `WORKFLOW_SAFE_MODE=1` when `WORKFLOW_SEQUENTIAL_REPLAYS` is not set
 * explicitly (safe mode fills the default of every safety-over-performance
 * flag; an explicit per-flag value always wins). Read at call time.
 */
export function isSequentialReplaysEnabled(): boolean {
  const explicit = process.env.WORKFLOW_SEQUENTIAL_REPLAYS;
  if (explicit !== undefined && explicit !== '') {
    return explicit === '1';
  }
  return process.env.WORKFLOW_SAFE_MODE === '1';
}

export function getWorkflowQueueTrigger(options?: { namespace?: string }) {
  return {
    ...createWorkflowQueueTrigger(options),
    ...(isSequentialReplaysEnabled() && {
      maxConcurrency: 1,
    }),
  };
}
