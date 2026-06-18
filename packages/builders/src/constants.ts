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
 *
 * When `workflowFilenames` is provided, the deduplicated, sorted list is
 * inlined so the runtime can precompile the bundle's `vm.Script` for each
 * source filename at module-init time (warming the cache before the first
 * queue delivery's replay). Sorting keeps the generated route file stable
 * across builds.
 */
export function createWorkflowEntrypointOptionsCode(options?: {
  namespace?: string;
  workflowFilenames?: string[];
}) {
  const namespace = resolveQueueNamespace(options?.namespace);

  const optionParts: string[] = [];

  if (namespace) {
    // Reuse prefix construction for namespace validation.
    getQueueTopicPrefix('workflow', namespace);
    optionParts.push(`namespace: ${JSON.stringify(namespace)}`);
  }

  const workflowFilenames = options?.workflowFilenames;
  if (workflowFilenames && workflowFilenames.length > 0) {
    const sorted = [...new Set(workflowFilenames)].sort();
    optionParts.push(`workflowFilenames: ${JSON.stringify(sorted)}`);
  }

  if (optionParts.length === 0) {
    return '';
  }

  return `, { ${optionParts.join(', ')} }`;
}

/**
 * Default queue trigger (no namespace). Backward compatible.
 */
export const WORKFLOW_QUEUE_TRIGGER = createWorkflowQueueTrigger();
