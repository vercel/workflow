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
  changes: Array<{ key: string; value: string | null }>
) {
  'use step';
  if (changes.length === 0) return;
  const g = globalThis as Record<symbol, unknown>;

  const contextStorage = g[Symbol.for('WORKFLOW_STEP_CONTEXT_STORAGE')] as
    | {
        getStore: () =>
          | { workflowMetadata?: { workflowRunId?: string } }
          | undefined;
      }
    | undefined;
  const runId = contextStorage?.getStore?.()?.workflowMetadata?.workflowRunId;
  if (!runId) {
    throw new Error(
      '__builtin_set_attributes: no workflow run id available in step context'
    );
  }

  const world = g[Symbol.for('@workflow/world//cache')] as
    | {
        runs?: {
          experimentalSetAttributes?: (
            runId: string,
            changes: Array<{ key: string; value: string | null }>
          ) => Promise<unknown>;
        };
      }
    | undefined;
  if (typeof world?.runs?.experimentalSetAttributes !== 'function') {
    // World adapter doesn't implement attributes yet — silently no-op.
    // The VM-side validation already ran, so input was well-formed.
    return;
  }

  await world.runs.experimentalSetAttributes(runId, changes);
}
