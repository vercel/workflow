import { WORKFLOW_OPTIONAL_OTEL_API_MODULE } from '@workflow/builders';
import { describe, expect, it } from 'vitest';
import { workflowTransformPlugin } from './index.js';

/**
 * `resolveId` is declared as `{ order, handler }`. Grab the handler so we can
 * call it directly. The `@opentelemetry/api` branch returns before touching the
 * Rollup plugin context, so an empty `this` is fine for these cases.
 */
function getResolveId() {
  const plugin = workflowTransformPlugin();
  const resolveId = plugin.resolveId;
  if (
    typeof resolveId !== 'object' ||
    typeof resolveId.handler !== 'function'
  ) {
    throw new Error('expected resolveId to be an object with a handler');
  }
  const handler = resolveId.handler;
  // Minimal plugin-context stub — the `@opentelemetry/api` branch returns
  // before touching `this`, so an empty context is sufficient here.
  return (source: string) =>
    handler.call({} as never, source, undefined, {} as never);
}

describe('workflowTransformPlugin resolveId', () => {
  it('marks the optional @opentelemetry/api peer external so builds do not fail when it is absent', async () => {
    const resolveId = getResolveId();

    // A bare static/dynamic `import('@opentelemetry/api')` from the bundled SDK
    // must not be resolved by Rollup/Vite — otherwise the build fails with
    // "failed to resolve import '@opentelemetry/api'" when the optional peer
    // isn't installed (regression: SvelteKit build break, PR #1947).
    await expect(resolveId(WORKFLOW_OPTIONAL_OTEL_API_MODULE)).resolves.toEqual(
      {
        id: WORKFLOW_OPTIONAL_OTEL_API_MODULE,
        external: true,
      }
    );
  });

  it('marks @opentelemetry/api subpaths external too', async () => {
    const resolveId = getResolveId();
    await expect(
      resolveId(`${WORKFLOW_OPTIONAL_OTEL_API_MODULE}/experimental`)
    ).resolves.toEqual({
      id: `${WORKFLOW_OPTIONAL_OTEL_API_MODULE}/experimental`,
      external: true,
    });
  });

  it('does not intercept unrelated specifiers', async () => {
    const resolveId = getResolveId();
    // A lookalike that is not the otel package must fall through (returns null),
    // so normal resolution still applies.
    await expect(resolveId('@opentelemetry/api-lookalike')).resolves.toBeNull();
    await expect(resolveId('some-other-package')).resolves.toBeNull();
  });
});
