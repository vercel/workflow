import { FatalError } from '@workflow/errors';
import {
  type AttributeChange,
  AttributeValidationError,
  validateAttributeChanges,
} from '@workflow/world';
import { WORKFLOW_USE_STEP } from '../symbols.js';

/**
 * Options accepted by `experimental_setAttributes`.
 */
export interface ExperimentalSetAttributesOptions {
  /**
   * Permit attribute keys that start with the reserved `$` prefix.
   * **Default: `false`.**
   *
   * The `$` namespace is reserved for framework and library code that
   * is built on top of the workflow SDK (telemetry, agent metadata,
   * platform-emitted tags, etc.). User code MUST NOT write keys in
   * this namespace; validation rejects them so accidental collisions
   * with tooling-owned keys can't slip through.
   *
   * Only flip this to `true` if your caller is itself a framework or
   * library that owns a `$`-prefixed sub-namespace and knows the
   * conventions of any other tools writing into it. Misuse can
   * conflict with observability surfaces, agent dashboards, or future
   * platform features that rely on the reserved namespace.
   */
  allowReservedAttributes?: boolean;
}

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
 * **Reserved namespace.** Keys starting with `$` are reserved for
 * framework/library code (telemetry, agent metadata, etc.). User code
 * trying to write a `$`-prefixed key throws `FatalError`. If you are a
 * framework author and need to set a reserved key, pass
 * `{ allowReservedAttributes: true }` as the second argument — see
 * `ExperimentalSetAttributesOptions` for the trade-offs.
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
 *
 * @example Framework / library code writing into the reserved namespace.
 * ```ts
 * await experimental_setAttributes(
 *   { '$agent.kind': 'durable-agent' },
 *   { allowReservedAttributes: true }
 * );
 * ```
 */
export async function experimental_setAttributes(
  attrs: Record<string, string | undefined>,
  options: ExperimentalSetAttributesOptions = {}
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
  const allowReservedAttributes = options.allowReservedAttributes === true;
  try {
    validateAttributeChanges(changes, { allowReservedAttributes });
  } catch (err) {
    if (err instanceof AttributeValidationError) {
      throw new FatalError(err.message);
    }
    throw err;
  }
  const useStep = (globalThis as Record<symbol, unknown>)[WORKFLOW_USE_STEP] as
    | ((
        stepName: string
      ) => (
        changes: AttributeChange[],
        options?: { allowReservedAttributes?: boolean }
      ) => Promise<void>)
    | undefined;
  if (!useStep) {
    throw new FatalError(
      'experimental_setAttributes() called outside a workflow runtime context. ' +
        'It must be called from within a workflow body (`use workflow`).'
    );
  }
  await useStep('__builtin_set_attributes')(
    changes,
    allowReservedAttributes ? { allowReservedAttributes: true } : {}
  );
}
