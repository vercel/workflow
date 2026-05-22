import { FatalError } from '@workflow/errors';
import { throwNotInWorkflowOrStepContext } from './context-errors.js';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import { normalizeSetAttributesInput } from './set-attributes-shared.js';
import { contextStorage } from './step/context-storage.js';
import { WORKFLOW_CONTEXT_SYMBOL } from './workflow/get-workflow-metadata.js';

let unsupportedWorldWarned = false;

function warnUnsupportedWorldOnce(worldName?: string): void {
  if (unsupportedWorldWarned) return;
  unsupportedWorldWarned = true;
  // biome-ignore lint/suspicious/noConsole: surface in user terminals
  console.warn(
    `[workflow] setAttributes: the current world implementation${
      worldName ? ` (${worldName})` : ''
    } does not implement experimentalSetAttributes; this call (and any subsequent setAttributes calls in this process) is a no-op. Attributes will become available once the world adapter adds support.`
  );
}

/**
 * Attach plaintext string key/value metadata to the current workflow run.
 *
 * **EXPERIMENTAL (MVP).** In V5, `setAttributes` may only be called from
 * a **step body**. Calling it from a workflow body throws `FatalError`.
 * To attach attributes from a workflow body, wrap the call in a step
 * yourself:
 *
 * ```ts
 * async function setRunAttrs(attrs: Record<string, string | undefined>) {
 *   'use step';
 *   await setAttributes(attrs);
 * }
 *
 * export async function myWorkflow() {
 *   'use workflow';
 *   await setRunAttrs({ phase: 'init' });
 * }
 * ```
 *
 * The full Workflow Attributes feature (5.0.0) lifts this restriction by
 * dispatching via `attr_set` events through the workflow controller; the
 * SDK signature stays the same, so user code that wraps in a step today
 * keeps working after the cutover.
 *
 * Validation runs client-side; violations throw `FatalError`. An empty
 * record is a no-op (no RPC).
 *
 * `value: undefined` removes the key from the run's attribute map.
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
  // Detect workflow-body context first so we can surface a clear error
  // instead of silently failing inside the VM. (`WORKFLOW_CONTEXT_SYMBOL`
  // is set by the host on the VM's globalThis during workflow eval.)
  const workflowCtx = (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] as
    | { workflowRunId?: string }
    | undefined;
  const stepCtx = contextStorage.getStore();

  if (workflowCtx && !stepCtx) {
    throw new FatalError(
      'setAttributes() can only be called from a step body in the V5 MVP. ' +
        "Wrap it: `async function setAttrs(a) { 'use step'; await setAttributes(a); }` " +
        'and call that from your workflow. The 5.0.0 attributes feature removes ' +
        'this restriction; see the attributes-mvp changelog entry.'
    );
  }

  const changes = normalizeSetAttributesInput(attrs);
  if (!changes) return;

  const runId = stepCtx?.workflowMetadata?.workflowRunId;
  if (!runId) {
    throwNotInWorkflowOrStepContext(
      'setAttributes()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/set-attributes',
      setAttributes
    );
  }

  const world = await getWorldLazy();
  if (typeof world.runs.experimentalSetAttributes !== 'function') {
    warnUnsupportedWorldOnce((world as any)?.name);
    return;
  }
  await world.runs.experimentalSetAttributes(runId, changes);
}
