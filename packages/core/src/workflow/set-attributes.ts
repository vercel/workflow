import { FatalError } from '@workflow/errors';
import type { AttributeChange } from '@workflow/world';
import { normalizeSetAttributesInput } from '../set-attributes-shared.js';
import { WORKFLOW_SET_ATTRIBUTES } from '../symbols.js';

/**
 * Workflow-VM-side `setAttributes`. Validates the input on the VM side
 * (cheap, deterministic) and then dispatches the canonical
 * `AttributeChange[]` through the host's `__builtin_set_attributes`
 * step bridge — registered on `globalThis` under `WORKFLOW_SET_ATTRIBUTES`
 * by the workflow runtime. The actual world call happens inside that
 * step, which gives the mutation an event-log entry (`step_created` →
 * `step_completed`) just like any other step.
 *
 * Empty input is a no-op (no step dispatch). `value: undefined` removes
 * the key from the run's attribute map.
 *
 * @example
 * ```ts
 * export async function myWorkflow() {
 *   'use workflow';
 *   await setAttributes({ phase: 'init' });
 *   // ... work ...
 *   await setAttributes({ phase: 'done' });
 * }
 * ```
 */
export async function setAttributes(
  attrs: Record<string, string | undefined>
): Promise<void> {
  const changes = normalizeSetAttributesInput(attrs);
  if (!changes) return;
  const dispatch = (globalThis as Record<symbol, unknown>)[
    WORKFLOW_SET_ATTRIBUTES
  ] as ((changes: AttributeChange[]) => Promise<void>) | undefined;
  if (!dispatch) {
    throw new FatalError(
      'setAttributes() called outside a workflow runtime context. ' +
        'The workflow VM must be initialized before this function is invoked.'
    );
  }
  await dispatch(changes);
}
