import type { AttributeChange } from '@workflow/world';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import { contextStorage } from './step/context-storage.js';

let unsupportedWorldWarned = false;

function warnUnsupportedWorldOnce(worldName?: string): void {
  if (unsupportedWorldWarned) return;
  unsupportedWorldWarned = true;
  // biome-ignore lint/suspicious/noConsole: surface in user terminals
  console.warn(
    `[workflow] setAttributes: the current world implementation${
      worldName ? ` (${worldName})` : ''
    } does not implement experimentalSetAttributes; this call (and any subsequent setAttributes calls in this process) is a no-op. Attributes will become available once the world adapter adds support.`
  );
}

/**
 * Host-side helper that applies a pre-normalized list of attribute
 * changes to the current run via the world adapter. Used by both the
 * step-body `setAttributes` entrypoint and the `__builtin_set_attributes`
 * step bridge that workflow-body calls dispatch into.
 *
 * Reads the active run id from the step context (`contextStorage`), so
 * it must be called from within a step body — either directly by the
 * step-side `setAttributes`, or indirectly via the builtin step
 * dispatched from a workflow body.
 *
 * @internal
 */
export async function applySetAttributesChanges(
  changes: AttributeChange[]
): Promise<void> {
  if (changes.length === 0) return;
  const stepCtx = contextStorage.getStore();
  const runId = stepCtx?.workflowMetadata?.workflowRunId;
  if (!runId) {
    throw new Error(
      'applySetAttributesChanges() called outside a step context'
    );
  }
  const world = await getWorldLazy();
  if (typeof world.runs.experimentalSetAttributes !== 'function') {
    warnUnsupportedWorldOnce((world as { name?: string })?.name);
    return;
  }
  await world.runs.experimentalSetAttributes(runId, changes);
}
