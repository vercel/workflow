import { Script } from 'node:vm';

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
}) {
  const namespace = resolveQueueNamespace(options?.namespace);

  if (!namespace) {
    return '';
  }

  // Reuse prefix construction for namespace validation.
  getQueueTopicPrefix('workflow', namespace);

  return `, { namespace: ${JSON.stringify(namespace)} }`;
}

/**
 * Variable name a generated route uses to hold the build-time V8 code cache.
 */
const WORKFLOW_CODE_CACHED_DATA_VAR = '__workflowCodeCachedData';

/**
 * Bundles below this size parse in ~1ms, so embedding a base64 code cache
 * (which roughly doubles the route's source size) is not worth it. Above it,
 * the cold-instance parse — the dominant first-replay cost — grows ~linearly
 * (~30ms/MB), and the cache skips it.
 */
const MIN_CODE_CACHE_BYTES = 256 * 1024;

/**
 * Builds the trailing pieces a generated flow route needs to hand a build-time
 * V8 code cache to `workflowEntrypoint`:
 *  - `cachedDataDecl`: a `const __workflowCodeCachedData = "<base64>";` line to
 *    emit right after `const workflowCode = ...` (empty when no cache).
 *  - `secondArg`: the full `, { namespace, cachedData }` argument string.
 *
 * The cache (`Script.createCachedData()`) lets a fresh serverless instance skip
 * parsing the bundle on its first replay. Skipped for small bundles and when
 * `WORKFLOW_DISABLE_BUNDLE_CODE_CACHE=1`. Generation failure degrades silently
 * to no cache; at runtime V8 also validates the blob and falls back to a full
 * parse on any mismatch, so this is never a correctness risk.
 *
 * Only for production (bundle-embedded) routes — dev/watch routes that read the
 * bundle from disk should keep using `createWorkflowEntrypointOptionsCode`.
 */
export function createWorkflowEntrypointArgs(
  workflowCode: string,
  options?: { namespace?: string }
): { cachedDataDecl: string; secondArg: string } {
  const namespace = resolveQueueNamespace(options?.namespace);
  if (namespace) {
    // Reuse prefix construction for namespace validation.
    getQueueTopicPrefix('workflow', namespace);
  }

  let cachedDataB64 = '';
  if (
    process.env.WORKFLOW_DISABLE_BUNDLE_CODE_CACHE !== '1' &&
    workflowCode.length >= MIN_CODE_CACHE_BYTES
  ) {
    try {
      const script = new Script(workflowCode, {
        filename: 'workflow-bundle.js',
      });
      cachedDataB64 = script.createCachedData().toString('base64');
    } catch {
      cachedDataB64 = '';
    }
  }

  const entries: string[] = [];
  if (namespace) {
    entries.push(`namespace: ${JSON.stringify(namespace)}`);
  }
  if (cachedDataB64) {
    entries.push(`cachedData: ${WORKFLOW_CODE_CACHED_DATA_VAR}`);
  }

  return {
    cachedDataDecl: cachedDataB64
      ? `const ${WORKFLOW_CODE_CACHED_DATA_VAR} = ${JSON.stringify(cachedDataB64)};\n`
      : '',
    secondArg: entries.length ? `, { ${entries.join(', ')} }` : '',
  };
}

/**
 * Default queue trigger (no namespace). Backward compatible.
 */
export const WORKFLOW_QUEUE_TRIGGER = createWorkflowQueueTrigger();
