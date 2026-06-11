import { FatalError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { normalizeAttributeChanges } from './attribute-changes.js';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import { contextStorage } from './step/context-storage.js';
import type { ExperimentalSetAttributesOptions } from './workflow/set-attributes.js';

export type { ExperimentalSetAttributesOptions };

/**
 * Host-side implementation for `experimental_setAttributes`. Workflow
 * bodies resolve to `./workflow/set-attributes.ts` via the `workflow`
 * package-exports condition; step bodies resolve here and can perform
 * the world write directly because they already run in host context.
 *
 * Plain application code still has no active workflow run, so it throws
 * a clear `FatalError`.
 */
export async function experimental_setAttributes(
  attrs: Record<string, string | undefined>,
  options: ExperimentalSetAttributesOptions = {}
): Promise<void> {
  const store = contextStorage.getStore();
  const runId = store?.workflowMetadata?.workflowRunId;
  if (!runId) {
    throw new FatalError(
      "experimental_setAttributes() must be called from a 'use workflow' or 'use step' function. " +
        'Calling it from plain host code is not supported.'
    );
  }

  const changes = normalizeAttributeChanges(attrs, options);
  if (changes.length === 0) return;

  const world = await getWorldLazy();
  await world.events.create(runId, {
    eventType: 'attr_set',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      changes,
      writer: {
        type: 'step',
        stepId: store.stepMetadata.stepId,
        attempt: store.stepMetadata.attempt,
      },
      ...(options.allowReservedAttributes === true
        ? { allowReservedAttributes: true }
        : {}),
    },
  });
}
