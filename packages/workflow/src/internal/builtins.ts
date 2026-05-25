/**
 * These are the built-in steps that are "automatically available" in the workflow scope. They are
 * similar to "stdlib" except that are not meant to be imported by users, but are instead "just available"
 * alongside user defined steps. They are used internally by the runtime
 */

export async function __builtin_response_array_buffer(
  this: Request | Response
) {
  'use step';
  return this.arrayBuffer();
}

export async function __builtin_response_json(this: Request | Response) {
  'use step';
  return this.json();
}

export async function __builtin_response_text(this: Request | Response) {
  'use step';
  return this.text();
}

/**
 * Internal step bridge that lets workflow-body `setAttributes` dispatch
 * the attribute change through the step queue. The workflow VM registers
 * a `useStep('__builtin_set_attributes')` dispatcher under the
 * `WORKFLOW_SET_ATTRIBUTES` global symbol; the workflow-side
 * `setAttributes` validates input, then calls the dispatcher with
 * canonical `{ key, value }[]` changes. This step runs in normal Node
 * context with full world access and forwards to the same code path the
 * step-body `setAttributes` uses.
 */
export async function __builtin_set_attributes(
  changes: Array<{ key: string; value: string | null }>
) {
  'use step';
  const { applySetAttributesChanges } = await import(
    '@workflow/core/_step-set-attributes'
  );
  await applySetAttributesChanges(changes);
}
