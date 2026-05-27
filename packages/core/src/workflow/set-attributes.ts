import { FatalError } from '@workflow/errors';
import {
  type AttributeChange,
  AttributeValidationError,
  validateAttributeChanges,
} from '@workflow/world';
import { WORKFLOW_USE_STEP } from '../symbols.js';

/**
 * Attach plaintext string key/value metadata to the current workflow run.
 *
 * **EXPERIMENTAL.** The `experimental_` prefix is deliberate — the
 * shape, semantics, and dispatch path are likely to change before this
 * is renamed to a stable export. Use only when you can absorb a
 * breaking rename later.
 *
 * Callable only from a workflow body (`'use workflow'`). The call is
 * dispatched through the workflow runtime as a step, so the mutation
 * is recorded in the event log and survives replay.
 *
 * Validation runs in the VM (cheap, deterministic) before the step
 * dispatch — violations throw `FatalError` without queuing a step. An
 * empty record is a no-op. `value: undefined` removes the key from the
 * run's attribute map.
 *
 * **WARNING**: While this feature is experimental, calling e.g.
 * `Promise.all([experimental_setAttributes({ a: '1' }), experimental_setAttributes({ a: '2' })])`
 * is not guaranteed to be ordered consistently, but the equivalent
 * sequential `.then()` chain is.
 *
 * @example
 * ```ts
 * import { experimental_setAttributes } from 'workflow';
 *
 * export async function myWorkflow() {
 *   'use workflow';
 *   await experimental_setAttributes({ phase: 'init' });
 *   // ... work ...
 *   await experimental_setAttributes({ phase: 'done', orderId: 'ord_123' });
 *   await experimental_setAttributes({ orderId: undefined }); // remove
 * }
 * ```
 */
export async function experimental_setAttributes(
  attrs: Record<string, string | undefined>
): Promise<void> {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    throw new FatalError(
      `experimental_setAttributes requires a plain object, got ${
        attrs === null ? 'null' : Array.isArray(attrs) ? 'array' : typeof attrs
      }`
    );
  }
  const changes: AttributeChange[] = Object.entries(attrs).map(
    ([key, value]) => ({
      key,
      value: value === undefined ? null : value,
    })
  );
  if (changes.length === 0) return;
  try {
    validateAttributeChanges(changes);
  } catch (err) {
    if (err instanceof AttributeValidationError) {
      throw new FatalError(err.message);
    }
    throw err;
  }
  const useStep = (globalThis as Record<symbol, unknown>)[WORKFLOW_USE_STEP] as
    | ((stepName: string) => (changes: AttributeChange[]) => Promise<void>)
    | undefined;
  if (!useStep) {
    throw new FatalError(
      'experimental_setAttributes() called outside a workflow runtime context. ' +
        'It must be called from within a workflow body (`use workflow`).'
    );
  }
  await useStep('__builtin_set_attributes')(changes);
}
