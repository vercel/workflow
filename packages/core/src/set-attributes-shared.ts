import { FatalError } from '@workflow/errors';
import type { AttributeChange } from '@workflow/world';
import {
  AttributeValidationError,
  validateAttributeChanges,
} from '@workflow/world';
import { getWorldLazy } from './runtime/get-world-lazy.js';

// IMPORTANT: this module is imported by both the workflow-VM bundle and
// the step/host bundle. It must NOT import anything that pulls in
// `node:async_hooks` (e.g. `step/context-storage.ts`) or any other
// Node-only module — the workflow VM bundle is built with a no-Node
// constraint, and an offending transitive import will fail the build
// with "You are attempting to use 'node:async_hooks' which is a Node.js
// module. Node.js modules are not available in workflow functions."

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
 * Internal step that performs the actual `experimentalSetAttributes`
 * call against the World. The `'use step'` directive means the function
 * body runs in a step (Node.js) context regardless of which surface
 * invoked it:
 *
 * - Called from a workflow body: dispatched as a step through the
 *   workflow controller, recorded in the event log
 *   (`step_created`/`step_completed`), replayed deterministically on
 *   resume.
 * - Called from a step body (or from Node.js outside a workflow): runs
 *   inline. Step bodies cannot nest steps; the directive is a no-op
 *   there and the function body executes as a plain async function.
 *
 * @internal
 */
export async function setAttributesStep(
  runId: string,
  changes: AttributeChange[]
): Promise<void> {
  'use step';
  const world = await getWorldLazy();
  if (typeof world.runs.experimentalSetAttributes !== 'function') {
    warnUnsupportedWorldOnce((world as any)?.name);
    return;
  }
  await world.runs.experimentalSetAttributes(runId, changes);
}

/**
 * Validate and normalize a `setAttributes(record)` call. Returns the
 * canonical `AttributeChange[]` shape (with `undefined → null`) or
 * throws `FatalError` on a violation. Returns `null` if the input is
 * empty (callers must short-circuit without dispatching a step).
 *
 * @internal
 */
export function normalizeSetAttributesInput(
  attrs: Record<string, string | undefined>
): AttributeChange[] | null {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    throw new FatalError(
      `setAttributes requires a plain object, got ${attrs === null ? 'null' : Array.isArray(attrs) ? 'array' : typeof attrs}`
    );
  }
  const changes: AttributeChange[] = Object.entries(attrs).map(
    ([key, value]) => ({
      key,
      value: value === undefined ? null : value,
    })
  );
  if (changes.length === 0) return null;
  try {
    validateAttributeChanges(changes);
  } catch (err) {
    if (err instanceof AttributeValidationError) {
      throw new FatalError(err.message);
    }
    throw err;
  }
  return changes;
}
