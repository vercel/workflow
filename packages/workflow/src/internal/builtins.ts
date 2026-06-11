/**
 * These are the built-in steps that are "automatically available" in the workflow scope. They are
 * similar to "stdlib" except that are not meant to be imported by users, but are instead "just available"
 * alongside user defined steps. They are used internally by the runtime
 */

export async function __builtin_response_array_buffer(
  this: Request | Response
) {
  'use step';
  return this.arrayBuffer();
}

export async function __builtin_response_json(this: Request | Response) {
  'use step';
  return this.json();
}

export async function __builtin_response_text(this: Request | Response) {
  'use step';
  return this.text();
}

/**
 * Process-wide dedupe for the unsupported-world warning so high-volume
 * callers don't flood logs.
 */
const UNSUPPORTED_WORLD_WARNED = Symbol.for(
  '@workflow/setAttributes//unsupportedWorldWarned'
);

const INTERNAL_ATTRIBUTES_MAX_ATTEMPTS = 3;

function formatUnknownError(error: unknown) {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Step bridge for workflow-body `setAttributes` calls. The VM-side
 * helper validates input and dispatches here via `useStep`. This step
 * runs in normal Node context with full world access.
 *
 * The dispatch reads the world and current run id directly from
 * `globalThis` symbols populated by the workflow/step runtime — this
 * intentionally avoids importing `@workflow/core` so the Next.js
 * deferred-entries discoverer can't walk a chain into world adapters
 * and `@vercel/queue` from this step file.
 */
export async function __builtin_set_attributes(
  changes: Array<{ key: string; value: string | null }>,
  options?: { allowReservedAttributes?: boolean }
) {
  'use step';
  if (changes.length === 0) return;
  const g = globalThis as Record<symbol, unknown>;

  const contextStorage = g[Symbol.for('WORKFLOW_STEP_CONTEXT_STORAGE')] as
    | {
        getStore: () =>
          | {
              stepMetadata?: { attempt?: number };
              workflowMetadata?: { workflowRunId?: string };
            }
          | undefined;
      }
    | undefined;
  const store = contextStorage?.getStore?.();
  const attempt =
    typeof store?.stepMetadata?.attempt === 'number'
      ? store.stepMetadata.attempt
      : INTERNAL_ATTRIBUTES_MAX_ATTEMPTS;

  const world = g[Symbol.for('@workflow/world//cache')] as
    | {
        name?: string;
        runs?: {
          experimentalSetAttributes?: (
            runId: string,
            changes: Array<{ key: string; value: string | null }>,
            options?: { allowReservedAttributes?: boolean }
          ) => Promise<unknown>;
        };
      }
    | undefined;
  if (typeof world?.runs?.experimentalSetAttributes !== 'function') {
    // World adapter doesn't implement attributes yet — no-op the call,
    // but emit one process-wide warning so users know their writes are
    // being dropped. The VM-side validation already ran so the input
    // is well-formed.
    if (!g[UNSUPPORTED_WORLD_WARNED]) {
      g[UNSUPPORTED_WORLD_WARNED] = true;
      const worldName = world?.name ? ` (${world.name})` : '';
      console.warn(
        `[workflow] setAttributes: the current world implementation${worldName} does not implement experimentalSetAttributes; this call (and any subsequent setAttributes calls in this process) is a no-op. Attributes will become available once the world adapter adds support.`
      );
    }
    return;
  }

  try {
    const runId = store?.workflowMetadata?.workflowRunId;
    if (!runId) {
      throw new Error(
        '__builtin_set_attributes: no workflow run id available in step context'
      );
    }

    await world.runs.experimentalSetAttributes(runId, changes, options);
  } catch (error) {
    if (attempt < INTERNAL_ATTRIBUTES_MAX_ATTEMPTS) {
      throw error;
    }

    // Failing to post tags should not fail a run during the experimental phase.
    // After three attempts, log and let the internal step complete so the
    // runtime does not convert retry exhaustion into a FatalError.
    console.error(
      `[workflow] setAttributes: failed to post tags after ${INTERNAL_ATTRIBUTES_MAX_ATTEMPTS} attempts; dropping the internal attribute write. ${formatUnknownError(error)}`
    );
  }
}

(
  __builtin_set_attributes as typeof __builtin_set_attributes & {
    maxRetries: number;
  }
).maxRetries = INTERNAL_ATTRIBUTES_MAX_ATTEMPTS - 1;
