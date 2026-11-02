import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKFLOW_OPTIONAL_OTEL_API_MODULE,
  WORKFLOW_OPTIONAL_WS_NATIVE_MODULES,
} from '@workflow/builders';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { transformMock } = vi.hoisted(() => ({
  transformMock: vi.fn(),
}));

vi.mock('@swc/core', () => ({
  transform: transformMock,
}));

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

/**
 * `ws` (world-vercel's WebSocket events transport) requires `bufferutil` and
 * `utf-8-validate` inside a try/catch and falls back to pure JS when they're
 * absent — which is the default, since neither is installed. The require has to
 * actually fail for that fallback to engage, and under Vite it doesn't: an
 * absent optional peer resolves to a stub, leaving `bufferUtil.mask` undefined
 * until a frame is masked. Externalizing makes the failure the designed one on
 * every bundler this plugin runs under.
 *
 * This is the shipped fix for what the workbench Vite/TanStack apps used to
 * work around locally via `nitro.rollupConfig.external`: because every
 * Nitro-based integration (and SvelteKit, and Astro) installs this plugin, a
 * real user gets it without hand-editing their own bundler config.
 */
describe('workflowTransformPlugin resolveId — ws optional native accelerators', () => {
  it.each([
    ...WORKFLOW_OPTIONAL_WS_NATIVE_MODULES,
  ])('marks %s external so nothing substitutes for it', async (name) => {
    const { resolveId } = getResolveId(() => null);
    await expect(resolveId(name)).resolves.toEqual({
      id: name,
      external: true,
    });
  });

  it('externalizes them even when they ARE installed', async () => {
    // Deliberately the opposite of the OTEL peer above. A resolvable
    // accelerator must still be externalized: bundling it pulls in the JS
    // wrapper without its native `.node` binding, which is the broken
    // half-module that throws "bufferUtil.mask is not a function" at runtime.
    // `ws`'s own try/catch fallback makes a failed require the safe path.
    const { ctx, resolveId } = getResolveId(() => ({
      id: '/node_modules/bufferutil/index.js',
      external: false,
    }));
    await expect(resolveId('bufferutil')).resolves.toEqual({
      id: 'bufferutil',
      external: true,
    });
    // Short-circuits before consulting the resolver at all.
    expect(ctx.resolve).not.toHaveBeenCalled();
  });

  it('covers deep imports into the accelerators', async () => {
    const { resolveId } = getResolveId(() => null);
    await expect(resolveId('bufferutil/fallback')).resolves.toEqual({
      id: 'bufferutil/fallback',
      external: true,
    });
  });

  it('does not intercept lookalike package names', async () => {
    const { resolveId } = getResolveId();
    await expect(resolveId('bufferutil-extra')).resolves.toBeNull();
    await expect(resolveId('ws')).resolves.toBeNull();
  });
});

describe('workflowTransformPlugin transform — workflow id basis', () => {
  const originalCwd = process.cwd();
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'workflow-rollup-'));
    transformMock.mockResolvedValue({ code: 'compiled', map: null });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
    transformMock.mockReset();
  });

  /** The relative filename handed to SWC, which is what the id is built from. */
  const transformedFilename = async (id: string): Promise<string> => {
    const plugin = workflowTransformPlugin();
    const transform = plugin.transform;
    if (typeof transform !== 'function') {
      throw new Error('expected transform to be a function');
    }
    await transform.call(
      {} as never,
      'export async function order() {\n  "use workflow";\n}',
      id
    );
    return transformMock.mock.calls.at(-1)?.[1]?.filename as string;
  };

  // A shared `workflows/` directory symlinked into the app, which this repo's
  // own workbench apps do. Rollup resolves the module to its real path outside
  // the app, while the builder globs it through the link: without resolving
  // the alias back, the two name the same workflow differently and every
  // `start()` enqueues an id the registry has never heard of.
  it('names a symlinked workflow by the path the app imports it through', async () => {
    mkdirSync(join(root, 'shared/workflows'), { recursive: true });
    writeFileSync(join(root, 'shared/workflows/order.ts'), '', 'utf-8');
    mkdirSync(join(root, 'app'), { recursive: true });
    symlinkSync(join(root, 'shared/workflows'), join(root, 'app/workflows'));
    process.chdir(join(root, 'app'));

    await expect(
      transformedFilename(join(root, 'shared/workflows/order.ts'))
    ).resolves.toBe('workflows/order.ts');
  });

  it('keeps naming a file under the app by its own relative path', async () => {
    mkdirSync(join(root, 'app/workflows'), { recursive: true });
    writeFileSync(join(root, 'app/workflows/order.ts'), '', 'utf-8');
    process.chdir(join(root, 'app'));

    await expect(
      transformedFilename(join(root, 'app/workflows/order.ts'))
    ).resolves.toBe('workflows/order.ts');
  });

  it('falls back to stripping ../ for a file no alias explains', async () => {
    mkdirSync(join(root, 'elsewhere/lib'), { recursive: true });
    writeFileSync(join(root, 'elsewhere/lib/order.ts'), '', 'utf-8');
    mkdirSync(join(root, 'app'), { recursive: true });
    process.chdir(join(root, 'app'));

    await expect(
      transformedFilename(join(root, 'elsewhere/lib/order.ts'))
    ).resolves.toBe('elsewhere/lib/order.ts');
  });
});

describe('workflowTransformPlugin transform', () => {
  it('does not implicitly load input source maps', async () => {
    transformMock.mockResolvedValueOnce({ code: 'compiled', map: null });

    const plugin = workflowTransformPlugin();
    const transform = plugin.transform;
    if (typeof transform !== 'function') {
      throw new Error('expected transform to be a function');
    }

    const source = `export async function example() {
  "use step";
}`;
    await transform.call({} as never, source, '/project/workflows/example.ts');

    expect(transformMock).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        inputSourceMap: false,
        sourceMaps: true,
        inlineSourcesContent: true,
      })
    );
  });
});
