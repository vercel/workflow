import { NotInWorkflowOrStepContextError } from '../context-violation-error.js';
import {
  normalizeSetAttributesInput,
  setAttributesStep,
} from '../set-attributes-shared.js';
import { WORKFLOW_CONTEXT_SYMBOL } from './get-workflow-metadata.js';

/**
 * Workflow-VM-side `setAttributes`. The exported symbol from
 * `@workflow/core/_workflow` (which the umbrella `workflow` package
 * re-exports under the workflow bundle).
 *
 * Only reads from `globalThis[WORKFLOW_CONTEXT_SYMBOL]` — the workflow
 * VM bundle is built without `node:async_hooks`, so it must not import
 * `contextStorage`. The step/host-side variant
 * (`packages/core/src/set-attributes.ts`) handles both contexts.
 *
 * The dispatch step (`setAttributesStep`) carries the `'use step'`
 * directive; the SWC plugin rewrites the call into a workflow
 * controller request so the body executes in the step (Node) context.
 *
 * See the `attributes-mvp` changelog entry for the full API spec.
 */
export async function setAttributes(
  attrs: Record<string, string | undefined>
): Promise<void> {
  const changes = normalizeSetAttributesInput(attrs);
  if (!changes) return;

  const workflowCtx = (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] as
    | { workflowRunId?: string }
    | undefined;
  const runId = workflowCtx?.workflowRunId;

  if (!runId) {
    throw new NotInWorkflowOrStepContextError(
      'setAttributes()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/set-attributes'
    );
  }

  await setAttributesStep(runId, changes);
}
