import { FatalError } from '@workflow/errors';
import type { AttributeChange } from '@workflow/world';
import {
  AttributeValidationError,
  validateAttributeChanges,
} from '@workflow/world';
import { throwNotInWorkflowOrStepContext } from './context-errors.js';
import { getWorldLazy } from './runtime/get-world-lazy.js';
import { contextStorage } from './step/context-storage.js';
import { WORKFLOW_CONTEXT_SYMBOL } from './workflow/get-workflow-metadata.js';

let unsupportedWorldWarned = false;

function warnUnsupportedWorldOnce(worldName?: string): void {
  if (unsupportedWorldWarned) return;
  unsupportedWorldWarned = true;
  // Use console.warn rather than the internal logger so the message
  // surfaces in user terminals regardless of debug configuration.
  // eslint-disable-next-line no-console
  console.warn(
    `[workflow] setAttributes: the current world implementation${
      worldName ? ` (${worldName})` : ''
    } does not implement experimentalSetAttributes; this call (and any subsequent setAttributes calls in this process) is a no-op. Attributes will become available once the world adapter adds support.`
  );
}

/**
 * Internal step that performs the actual `experimentalSetAttributes` call
 * against the World. The `'use step'` directive means:
 *
 * - Called from a workflow body: dispatched as a step through the workflow
 *   controller, recorded in the event log (`step_created`/`step_completed`),
 *   replayed deterministically on resume.
 * - Called from a step body (or from Node.js outside a workflow): executes
 *   inline. Step bodies cannot nest steps; the directive is a no-op here
 *   and the function body runs as a plain async function.
 *
 * Both paths converge on the same world method, so the wire format is
 * identical regardless of where the call originated.
 *
 * @internal
 */
async function setAttributesStep(
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
 * Attach plaintext string key/value metadata to the current workflow run.
 *
 * Available in both workflow bodies and step bodies. Validation runs
 * client-side; violations throw `FatalError`. An empty record is a no-op
 * (no RPC, no events).
 *
 * `value: undefined` removes the key from the run's attribute map.
 *
 * EXPERIMENTAL (MVP): this is a write-only API in V5. Reads, list/filter
 * endpoints, and initial attributes at `start()` ship with the full
 * Workflow Attributes feature — see the `attributes-mvp` changelog entry
 * for the migration path.
 *
 * @example
 * ```ts
 * await setAttributes({ phase: 'processing', orderId: 'ord_123' });
 * await setAttributes({ orderId: undefined }); // remove
 * ```
 */
export async function setAttributes(
  attrs: Record<string, string | undefined>
): Promise<void> {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    throw new FatalError(
      `setAttributes requires a plain object, got ${attrs === null ? 'null' : Array.isArray(attrs) ? 'array' : typeof attrs}`
    );
  }

  // Resolve the run ID from whichever context we are in. Workflow VM
  // context sets WORKFLOW_CONTEXT_SYMBOL on globalThis; step Node.js
  // context uses AsyncLocalStorage. Either path exposes
  // `workflowRunId` via the workflow metadata object.
  const workflowCtx = (globalThis as any)[WORKFLOW_CONTEXT_SYMBOL] as
    | { workflowRunId?: string }
    | undefined;
  const stepCtx = contextStorage.getStore();
  const runId =
    workflowCtx?.workflowRunId ?? stepCtx?.workflowMetadata?.workflowRunId;

  if (!runId) {
    throwNotInWorkflowOrStepContext(
      'setAttributes()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/set-attributes',
      setAttributes
    );
  }

  const changes: AttributeChange[] = Object.entries(attrs).map(
    ([key, value]) => ({
      key,
      value: value === undefined ? null : value,
    })
  );

  if (changes.length === 0) return;

  try {
    validateAttributeChanges(changes);
  } catch (err) {
    if (err instanceof AttributeValidationError) {
      throw new FatalError(err.message);
    }
    throw err;
  }

  await setAttributesStep(runId, changes);
}
