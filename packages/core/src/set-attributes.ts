import { FatalError } from '@workflow/errors';
import { normalizeAttributeChanges } from './attribute-changes.js';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import { contextStorage } from './step/context-storage.js';
import type { ExperimentalSetAttributesOptions } from './workflow/set-attributes.js';

export type { ExperimentalSetAttributesOptions };

const UNSUPPORTED_WORLD_WARNED = Symbol.for(
  '@workflow/setAttributes//unsupportedWorldWarned'
);

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
  if (typeof world.runs.experimentalSetAttributes !== 'function') {
    const g = globalThis as Record<symbol, unknown>;
    if (!g[UNSUPPORTED_WORLD_WARNED]) {
      g[UNSUPPORTED_WORLD_WARNED] = true;
      const name =
        'name' in world && typeof world.name === 'string' ? world.name : '';
      const worldName = name ? ` (${name})` : '';
      console.warn(
        `[workflow] setAttributes: the current world implementation${worldName} does not implement experimentalSetAttributes; this call (and any subsequent setAttributes calls in this process) is a no-op. Attributes will become available once the world adapter adds support.`
      );
    }
    return;
  }

  await world.runs.experimentalSetAttributes(
    runId,
    changes,
    options.allowReservedAttributes === true
      ? { allowReservedAttributes: true }
      : {}
  );
}
