import { FatalError } from '@workflow/errors';
import type { AttributeChange } from '@workflow/world';
import {
  AttributeValidationError,
  validateAttributeChanges,
} from '@workflow/world';

// IMPORTANT: this module is imported by both the workflow-VM bundle and
// the step/host bundle. It must NOT import anything that pulls in
// `node:async_hooks` (e.g. `step/context-storage.ts`) or any other
// Node-only module — the workflow VM bundle is built with a no-Node
// constraint, and an offending transitive import will fail the build
// with "You are attempting to use 'node:async_hooks' which is a Node.js
// module. Node.js modules are not available in workflow functions."
//
// It must ALSO not contain a `'use step'` directive: the deferred-entry
// discoverer in `@workflow/next/builder-deferred.ts` walks transitive
// imports from `'use step'` files, and adding a step file to
// `@workflow/core/dist/` puts the host-side `world.ts` (and its
// transitive `@vercel/queue` + adapter imports) inside the workflow
// step-discovery graph. That triggers a stack overflow inside webpack
// dev mode's regex-based import extractor on tarball-installed
// deployments. The MVP works around this by performing the world
// dispatch from the SDK helper (step body only); workflow-body use
// throws FatalError — users must wrap the call in their own
// `'use step'` function.

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
