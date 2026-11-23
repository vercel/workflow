// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type Plugin, type Rollup } from 'vite';
import { describe, expect, test } from 'vitest';
import { nodeRequireBanner } from './vite-plugin-node-require';

const BUILD_TEST_TIMEOUT_MS = 30_000;

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

function serverBanner(): string {
  const rollupOptions: { output?: { banner?: string } } = {};
  const config = { command: 'build', build: { ssr: true, rollupOptions } };
  (nodeRequireBanner().configResolved as (config: unknown) => void)(config);
  return rollupOptions.output?.banner ?? '';
}

async function runChunk(code: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-web-banner-'));
  try {
    const file = join(dir, 'chunk.mjs');
    await writeFile(file, code);
    return execFileSync(process.execPath, [file], { encoding: 'utf8' });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

describe('nodeRequireBanner', () => {
  // The load-bearing assertion: without this banner, bundled undici's lazy
  // `require('node:http2')` finds no `require` in the ESM server bundle, falls
  // back to a stub with no `http2.connect`, and every HTTP/2 request (the v4
  // events API + stream writes) breaks — silently degrading observability
  // reads. See vite-plugin-node-require.ts for the full mechanism.
  test(
    'injects the global-require shim into the SSR server build',
    async () => {
      // rollup may re-quote / reflow the banner, so assert on its semantic parts
      // rather than the exact source string.
      const code = await buildChunkCode({ ssr: true, withPlugin: true });
      expect(code).toContain('__wkfCreateRequire');
      expect(code).toContain('globalThis.require');
      expect(code).toMatch(/createRequire[\s\S]*from ['"]node:module['"]/);
    },
    BUILD_TEST_TIMEOUT_MS
  );

  test(
    'does not inject the shim into the client/browser build',
    async () => {
      const code = await buildChunkCode({ ssr: false, withPlugin: true });
      expect(code).not.toContain('__wkfCreateRequire');
    },
    BUILD_TEST_TIMEOUT_MS
  );

  test(
    'the SSR build has no shim without the plugin (guards the assertion)',
    async () => {
      const code = await buildChunkCode({ ssr: true, withPlugin: false });
      expect(code).not.toContain('__wkfCreateRequire');
    },
    BUILD_TEST_TIMEOUT_MS
  );

  test(
    'loads a server chunk that declares its own `require`',
    async () => {
      const stdout = await runChunk(
        `${serverBanner()}\nconst require = () => 'chunk';\nconsole.log(typeof globalThis.require, require());\n`
      );

      expect(stdout.trim()).toBe('function chunk');
    },
    BUILD_TEST_TIMEOUT_MS
  );
});
