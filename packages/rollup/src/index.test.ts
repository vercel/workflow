import { WORKFLOW_OPTIONAL_OTEL_API_MODULE } from '@workflow/builders';
import { describe, expect, it, vi } from 'vitest';
import { workflowTransformPlugin } from './index.js';

/**
 * `resolveId` is declared as `{ order, handler }`. Grab the handler so we can
 * call it directly with a stub plugin context. `resolveFn` mocks Rollup's
 * `this.resolve`: return a resolved id to simulate the optional peer being
 * installed, or `null` to simulate it being absent.
 */
function getResolveId(resolveFn: (source: string) => unknown = () => null) {
  const plugin = workflowTransformPlugin();
  const resolveId = plugin.resolveId;
  if (
    typeof resolveId !== 'object' ||
    typeof resolveId.handler !== 'function'
  ) {
    throw new Error('expected resolveId to be an object with a handler');
  }
  const handler = resolveId.handler;
  const ctx = { resolve: vi.fn((source: string) => resolveFn(source)) };
  return {
    ctx,
    resolveId: (source: string) =>
      handler.call(ctx as never, source, undefined, {} as never),
  };
}

describe('workflowTransformPlugin resolveId — @opentelemetry/api optional peer', () => {
  it('marks it external when the peer is not installed so the build does not fail', async () => {
    // Absent peer → `this.resolve` yields null. A bare
    // `import('@opentelemetry/api')` from the bundled SDK must then be marked
    // external instead of failing with "failed to resolve import
    // '@opentelemetry/api'" (regression: SvelteKit build break, PR #1947).
    const { resolveId } = getResolveId(() => null);
    await expect(resolveId(WORKFLOW_OPTIONAL_OTEL_API_MODULE)).resolves.toEqual(
      { id: WORKFLOW_OPTIONAL_OTEL_API_MODULE, external: true }
    );
  });

  it('marks subpaths external too when the peer is absent', async () => {
    const { resolveId } = getResolveId(() => null);
    await expect(
      resolveId(`${WORKFLOW_OPTIONAL_OTEL_API_MODULE}/experimental`)
    ).resolves.toEqual({
      id: `${WORKFLOW_OPTIONAL_OTEL_API_MODULE}/experimental`,
      external: true,
    });
  });

  it('lets it resolve and bundle when the peer IS installed', async () => {
    // Installed peer → `this.resolve` yields a resolved id. It must NOT be
    // externalized: self-contained outputs (Nitro's `.output/server`, esbuild)
    // ship no node_modules, so an externalized runtime import would crash with
    // ERR_MODULE_NOT_FOUND. Return the resolved id so it gets bundled.
    const resolvedId = {
      id: '/node_modules/@opentelemetry/api/index.js',
      external: false,
    };
    const { resolveId } = getResolveId(() => resolvedId);
    await expect(resolveId(WORKFLOW_OPTIONAL_OTEL_API_MODULE)).resolves.toBe(
      resolvedId
    );
  });

  it('does not intercept unrelated specifiers', async () => {
    const { resolveId } = getResolveId();
    // A lookalike that is not the otel package must fall through (returns null),
    // so normal resolution still applies.
    await expect(resolveId('@opentelemetry/api-lookalike')).resolves.toBeNull();
    await expect(resolveId('some-other-package')).resolves.toBeNull();
  });
});
