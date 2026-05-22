import { throwNotInWorkflowOrStepContext } from './context-errors.js';
import {
  normalizeSetAttributesInput,
  setAttributesStep,
} from './set-attributes-shared.js';
import { contextStorage } from './step/context-storage.js';
import { WORKFLOW_CONTEXT_SYMBOL } from './workflow/get-workflow-metadata.js';

/**
 * Attach plaintext string key/value metadata to the current workflow run.
 *
 * Available in both workflow bodies and step bodies — this is the
 * step/host-side entry point (re-exported from `@workflow/core` and
 * `workflow`). The workflow-VM bundle exposes a parallel implementation
 * that does not transitively import `node:async_hooks`; see
 * `./workflow/set-attributes.ts`.
 *
 * Validation runs client-side; violations throw `FatalError`. An empty
 * record is a no-op (no RPC, no events).
 *
 * `value: undefined` removes the key from the run's attribute map.
 *
 * EXPERIMENTAL (MVP): this is a write-only API in V5. Reads, list/filter
 * endpoints, and initial attributes at `start()` ship with the full
 * Workflow Attributes feature — see the `attributes-mvp` changelog entry
 * for the migration path.
 *
 * @example
 * ```ts
 * await setAttributes({ phase: 'processing', orderId: 'ord_123' });
 * await setAttributes({ orderId: undefined }); // remove
 * ```
 */
export async function setAttributes(
  attrs: Record<string, string | undefined>
): Promise<void> {
  const changes = normalizeSetAttributesInput(attrs);
  if (!changes) return;

  // Resolve the run ID from whichever context we are in. Step Node.js
  // context uses AsyncLocalStorage (`contextStorage`); the workflow VM
  // context sets `WORKFLOW_CONTEXT_SYMBOL` on globalThis. Either path
  // exposes `workflowRunId` via the workflow metadata object.
  const stepCtx = contextStorage.getStore();
  const workflowCtx = (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] as
    | { workflowRunId?: string }
    | undefined;
  const runId =
    stepCtx?.workflowMetadata?.workflowRunId ?? workflowCtx?.workflowRunId;

  if (!runId) {
    throwNotInWorkflowOrStepContext(
      'setAttributes()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/set-attributes',
      setAttributes
    );
  }

  await setAttributesStep(runId, changes);
}
