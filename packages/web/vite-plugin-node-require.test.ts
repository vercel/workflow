// @vitest-environment node
import { build, type Plugin, type Rollup } from 'vite';
import { describe, expect, test } from 'vitest';
import { nodeRequireBanner } from './vite-plugin-node-require';

// A virtual entry so the build needs no real files on disk. The body is
// irrelevant — we only care about the banner the plugin prepends to the chunk.
function virtualEntry(): Plugin {
  const id = 'virtual:entry';
  const resolved = `\0${id}`;
  return {
    name: 'test:virtual-entry',
    resolveId(source) {
      return source === id ? resolved : null;
    },
    load(thisId) {
      return thisId === resolved ? 'export const ok = true;' : null;
    },
  };
}

async function buildChunkCode(opts: {
  ssr: boolean;
  withPlugin: boolean;
}): Promise<string> {
  const result = (await build({
    logLevel: 'silent',
    configFile: false,
    build: {
      ssr: opts.ssr,
      write: false,
      minify: false,
      rollupOptions: { input: 'virtual:entry' },
    },
    plugins: [
      virtualEntry(),
      ...(opts.withPlugin ? [nodeRequireBanner()] : []),
    ],
  })) as Rollup.RollupOutput;
  const chunk = result.output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('no chunk emitted');
  return chunk.code;
}

describe('nodeRequireBanner', () => {
  // The load-bearing assertion: without this banner, bundled undici's lazy
  // `require('node:http2')` finds no `require` in the ESM server bundle, falls
  // back to a stub with no `http2.connect`, and every HTTP/2 request (the v4
  // events API + stream writes) breaks — silently degrading observability
  // reads. See vite-plugin-node-require.ts for the full mechanism.
  test('injects the global-require shim into the SSR server build', async () => {
    // rollup may re-quote / reflow the banner, so assert on its semantic parts
    // rather than the exact source string.
    const code = await buildChunkCode({ ssr: true, withPlugin: true });
    expect(code).toContain('__wkfCreateRequire');
    expect(code).toContain('globalThis.require');
    expect(code).toMatch(/createRequire[\s\S]*from ['"]node:module['"]/);
  });

  test('does not inject the shim into the client/browser build', async () => {
    const code = await buildChunkCode({ ssr: false, withPlugin: true });
    expect(code).not.toContain('__wkfCreateRequire');
  });

  test('the SSR build has no shim without the plugin (guards the assertion)', async () => {
    const code = await buildChunkCode({ ssr: true, withPlugin: false });
    expect(code).not.toContain('__wkfCreateRequire');
  });
});
