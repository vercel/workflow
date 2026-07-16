import { FatalError } from '@workflow/errors';
import type { AttributeChange } from '@workflow/world';
import { normalizeAttributeChanges } from '../attribute-changes.js';
import { WORKFLOW_SET_ATTRIBUTES } from '../symbols.js';

/**
 * Options accepted by `setAttributes`.
 */
export interface SetAttributesOptions {
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
 * @deprecated Use {@link SetAttributesOptions} instead.
 */
export type ExperimentalSetAttributesOptions = SetAttributesOptions;

/**
 * Attach plaintext string key/value metadata to the current workflow run.
 *
 * Callable only from a workflow body (`'use workflow'`). The call is
 * dispatched as a native `attr_set` event and materialized on the run.
 *
 * Validation runs in the VM (cheap, deterministic) before event
 * dispatch - violations throw `FatalError` without writing an event. An
 * empty record is a no-op. `value: undefined` removes the key from the
 * run's attribute map.
 *
 * **Reserved namespace.** Keys starting with `$` are reserved for
 * framework/library code (telemetry, agent metadata, etc.). User code
 * trying to write a `$`-prefixed key throws `FatalError`. If you are a
 * framework author and need to set a reserved key, pass
 * `{ allowReservedAttributes: true }` as the second argument — see
 * `SetAttributesOptions` for the trade-offs.
 *
 * **WARNING**: Calling e.g.
 * `Promise.all([setAttributes({ a: '1' }), setAttributes({ a: '2' })])`
 * is not guaranteed to be ordered consistently, but the equivalent
 * sequential `.then()` chain is.
 *
 * @example
 * ```ts
 * import { setAttributes } from 'workflow';
 *
 * export async function myWorkflow() {
 *   'use workflow';
 *   await setAttributes({ phase: 'init' });
 *   // ... work ...
 *   await setAttributes({ phase: 'done', orderId: 'ord_123' });
 *   await setAttributes({ orderId: undefined }); // remove
 * }
 * ```
 *
 * @example Framework / library code writing into the reserved namespace.
 * ```ts
 * await setAttributes(
 *   { '$agent.kind': 'durable-agent' },
 *   { allowReservedAttributes: true }
 * );
 * ```
 */
export async function setAttributes(
  attrs: Record<string, string | undefined>,
  options: SetAttributesOptions = {}
): Promise<void> {
  const changes = normalizeAttributeChanges(attrs, options);
  if (changes.length === 0) return;
  const allowReservedAttributes = options.allowReservedAttributes === true;
  const dispatchSetAttributes = (globalThis as Record<symbol, unknown>)[
    WORKFLOW_SET_ATTRIBUTES
  ] as
    | ((
        changes: AttributeChange[],
        options?: { allowReservedAttributes?: boolean }
      ) => Promise<void>)
    | undefined;
  if (!dispatchSetAttributes) {
    throw new FatalError(
      'setAttributes() called outside a workflow runtime context. ' +
        'It must be called from within a workflow body (`use workflow`).'
    );
  }
  await dispatchSetAttributes(
    changes,
    allowReservedAttributes ? { allowReservedAttributes: true } : {}
  );
}

/**
 * @deprecated The feature is no longer experimental — use
 * {@link setAttributes} instead.
 */
export const experimental_setAttributes = setAttributes;
