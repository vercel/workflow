import { FatalError } from '@workflow/errors';

/**
 * Host-side stub for `setAttributes`. The real implementation lives in
 * `./workflow/set-attributes.ts` and is selected by the `workflow`
 * package-exports condition when the workflow VM bundle is resolved.
 *
 * Reaching this stub means `setAttributes` was called outside a workflow
 * body — most likely from a `'use step'` function or plain host code.
 * That isn't supported: attribute mutations must be event-sourced
 * through the workflow runtime so they survive replay.
 */
export async function setAttributes(
  _attrs: Record<string, string | undefined>
): Promise<void> {
  throw new FatalError(
    "setAttributes() must be called from a 'use workflow' function. " +
      'Calling it from a step body or plain host code is not supported.'
  );
}
