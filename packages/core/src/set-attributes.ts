import { FatalError } from '@workflow/errors';
import { throwNotInWorkflowOrStepContext } from './context-errors.js';
import { normalizeSetAttributesInput } from './set-attributes-shared.js';
import { contextStorage } from './step/context-storage.js';
import { applySetAttributesChanges } from './step-set-attributes.js';
import { WORKFLOW_CONTEXT_SYMBOL } from './workflow/get-workflow-metadata.js';

/**
 * Attach plaintext string key/value metadata to the current workflow run.
 *
 * **EXPERIMENTAL.** Callable from both a workflow body and a step body.
 * Workflow-body calls dispatch through an internal step bridge so the
 * mutation is recorded in the event log; step-body calls hit the world
 * adapter directly.
 *
 * **WARNING**: While this features is experimental, calling e.g.
 * `Promise.all([setAttributes({ a: '1' }), setAttributes({ a: '2' })])`
 * is not guaranteed to be ordered consistently, but
 * `await setAttributes({ a: '1' }).then(() => setAttributes({ a: '2' }))`
 * is.
 *
 * Validation runs client-side; violations throw `FatalError`. An empty
 * record is a no-op (no RPC). `value: undefined` removes the key from
 * the run's attribute map.
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
  const workflowCtx = (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] as
    | { workflowRunId?: string }
    | undefined;
  const stepCtx = contextStorage.getStore();

  // Workflow-body invocation: this module is loaded in step/host bundles,
  // so reaching here from the VM means the workflow-side
  // `set-attributes` shim mistakenly resolved to this file. Surface a
  // clear error rather than silently misbehaving.
  if (workflowCtx && !stepCtx) {
    throw new FatalError(
      'setAttributes(): unexpected workflow-VM invocation of the step-side helper. ' +
        'This indicates a bundling misconfiguration — the workflow VM should resolve ' +
        '`setAttributes` through `@workflow/core/_workflow/set-attributes`.'
    );
  }

  const changes = normalizeSetAttributesInput(attrs);
  if (!changes) return;

  if (!stepCtx?.workflowMetadata?.workflowRunId) {
    throwNotInWorkflowOrStepContext(
      'setAttributes()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/set-attributes',
      setAttributes
    );
  }

  await applySetAttributesChanges(changes);
}
