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
 * **EXPERIMENTAL.** Callable only from a workflow body (`'use workflow'`).
 * The call is dispatched through the workflow runtime as a step, so the
 * mutation is recorded in the event log and survives replay.
 *
 * Validation runs in the VM (cheap, deterministic) before the step
 * dispatch — violations throw `FatalError` without queuing a step. An
 * empty record is a no-op. `value: undefined` removes the key from the
 * run's attribute map.
 *
 * **WARNING**: While this feature is experimental, calling e.g.
 * `Promise.all([setAttributes({ a: '1' }), setAttributes({ a: '2' })])`
 * is not guaranteed to be ordered consistently, but
 * `await setAttributes({ a: '1' }).then(() => setAttributes({ a: '2' }))`
 * is.
 *
 * @example
 * ```ts
 * export async function myWorkflow() {
 *   'use workflow';
 *   await setAttributes({ phase: 'init' });
 *   // ... work ...
 *   await setAttributes({ phase: 'done', orderId: 'ord_123' });
 *   await setAttributes({ orderId: undefined }); // remove
 * }
 * ```
 */
export async function setAttributes(
  attrs: Record<string, string | undefined>
): Promise<void> {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    throw new FatalError(
      `setAttributes requires a plain object, got ${
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
      'setAttributes() called outside a workflow runtime context. ' +
        'It must be called from within a workflow body (`use workflow`).'
    );
  }
  await useStep('__builtin_set_attributes')(changes);
}
