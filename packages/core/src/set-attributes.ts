import { FatalError } from '@workflow/errors';
import type { ExperimentalSetAttributesOptions } from './workflow/set-attributes.js';

export type { ExperimentalSetAttributesOptions };

/**
 * Host-side stub for `experimental_setAttributes`. The real
 * implementation lives in `./workflow/set-attributes.ts` and is
 * selected by the `workflow` package-exports condition when the
 * workflow VM bundle is resolved.
 *
 * Reaching this stub means the function was called outside a workflow
 * body — most likely from a `'use step'` function or plain host code.
 * That isn't supported in the MVP: attribute mutations must be
 * event-sourced through the workflow runtime so they survive replay.
 */
export async function experimental_setAttributes(
  _attrs: Record<string, string | undefined>,
  _options?: ExperimentalSetAttributesOptions
): Promise<void> {
  throw new FatalError(
    "experimental_setAttributes() must be called from a 'use workflow' function. " +
      'Calling it from a step body or plain host code is not supported.'
  );
}
