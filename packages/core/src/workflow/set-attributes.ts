import { FatalError } from '@workflow/errors';

/**
 * Workflow-VM-side `setAttributes` for V5 MVP.
 *
 * In V5 MVP, `setAttributes` is restricted to **step bodies** — calling
 * it from inside a workflow body throws `FatalError`. The restriction
 * exists because dispatching the call through the workflow controller
 * requires either a `'use step'`-tagged helper inside `@workflow/core`
 * (which trips the deferred-entry discoverer in `nextjs-webpack` dev
 * mode by adding host-side world adapters to the step-discovery graph)
 * or host-side bridge wiring comparable in scope to `sleep`. Neither is
 * worth the complexity for the MVP, given that wrapping a single line
 * in a `'use step'` function in user code is trivial:
 *
 * ```ts
 * async function setAttrs(attrs: Record<string, string | undefined>) {
 *   'use step';
 *   await setAttributes(attrs);
 * }
 *
 * export async function myWorkflow() {
 *   'use workflow';
 *   await setAttrs({ phase: 'init' });
 * }
 * ```
 *
 * The full Workflow Attributes feature in 5.0.0 dispatches via
 * `attr_set` events through the workflow controller and lifts this
 * restriction. The SDK signature does not change.
 */
export async function setAttributes(
  _attrs: Record<string, string | undefined>
): Promise<void> {
  throw new FatalError(
    'setAttributes() can only be called from a step body in the V5 MVP. ' +
      "Wrap it: `async function setAttrs(a) { 'use step'; await setAttributes(a); }` " +
      'and call that from your workflow. The 5.0.0 attributes feature removes ' +
      'this restriction; see the attributes-mvp changelog entry.'
  );
}
