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
// constraint, and an offending transitive import will fail the build.
//
// It must ALSO not contain a `'use step'` directive: the deferred-entry
// discoverer in `@workflow/next/builder-deferred.ts` walks transitive
// imports from `'use step'` files, and a step file inside
// `@workflow/core/dist/` puts host-side world adapters and
// `@vercel/queue` into the step-discovery graph, which has historically
// triggered a stack overflow inside webpack's regex-based extractor on
// tarball-installed deployments. The workflow-body step bridge lives
// in `packages/workflow/src/internal/builtins.ts` instead.

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
