// Runs both builds of the plugin inside real @swc/core releases: the main
// export on @swc/core 1.15 (the catalog version) and `./swc-1.16` on 1.16.
//
// The Rust fixture tests compile the transform natively and print its AST
// directly, so they cannot see what only happens inside a host: swc running
// its hygiene pass over the plugin's output, or a plugin failing to load on a
// host whose swc_core it wasn't built for. These tests transform every fixture
// on each host and require the two builds to print the same code.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const swc115 = require('@swc/core');
const swc116 = require('swc-core-1-16');
const plugin115 = require.resolve('@workflow/swc-plugin');
const plugin116 = require.resolve('@workflow/swc-plugin/swc-1.16');

const fixtureDir = fileURLToPath(
  new URL('../transform/tests/fixture/', import.meta.url)
);
const inputs = readdirSync(fixtureDir).flatMap((name) =>
  ['input.js', 'input.ts']
    .filter((file) => {
      try {
        readFileSync(join(fixtureDir, name, file));
        return true;
      } catch {
        return false;
      }
    })
    .map((file) => [name, join(fixtureDir, name, file)])
);

function transform(swc, plugin, mode, file) {
  return swc.transform(readFileSync(file, 'utf-8'), {
    filename: `workflows/${file.endsWith('.ts') ? 'input.ts' : 'input.js'}`,
    jsc: {
      parser: {
        syntax: file.endsWith('.ts') ? 'typescript' : 'ecmascript',
      },
      target: 'es2022',
      experimental: { plugins: [[plugin, { mode }]] },
    },
    module: { type: 'es6' },
    sourceMaps: false,
    minify: false,
  });
}

describe('the hosts', () => {
  it('are the @swc/core lines the two builds are for', () => {
    expect(swc115.version).toMatch(/^1\.15\./);
    expect(swc116.version).toMatch(/^1\.16\./);
  });
});

// The package's `@swc/core` peer range starts at 1.15.0, and the 1.16 build at
// 1.16.0: each build has to load on the first release of its line too. Their
// output isn't compared with the hosts above, because @swc/core prints some
// code differently between patch releases (1.15.0 and 1.15.3 differ on about
// a third of the fixtures with the same plugin).
describe.each([
  ['1.15.0', 'swc-core-1-15-0', plugin115],
  ['1.16.0', 'swc-core-1-16-0', plugin116],
])('on @swc/core %s, its build', (version, pkg, plugin) => {
  const swc = require(pkg);
  it('is that release', () => {
    expect(swc.version).toBe(version);
  });
  it.each(inputs)('transforms %s', async (_, file) => {
    const { code } = await transform(swc, plugin, 'step', file);
    expect(code).toContain('__internal_workflows');
  });
});

describe('each build loads only on its own @swc/core line', () => {
  const [, file] = inputs[0];
  it('rejects the 1.16 build on @swc/core 1.15', async () => {
    await expect(transform(swc115, plugin116, 'step', file)).rejects.toThrow(
      /failed to invoke plugin/
    );
  });
  it('rejects the 1.15 build on @swc/core 1.16', async () => {
    await expect(transform(swc116, plugin115, 'step', file)).rejects.toThrow(
      /failed to invoke plugin/
    );
  });
});

describe.each(['step', 'workflow', 'detect'])('%s mode', (mode) => {
  it.each(
    inputs
  )('%s: the 1.16 build on @swc/core 1.16 prints what the 1.15 build prints on 1.15', async (_, file) => {
    const [onSwc115, onSwc116] = await Promise.all([
      transform(swc115, plugin115, mode, file),
      transform(swc116, plugin116, mode, file),
    ]);
    expect(onSwc116.code).toBe(onSwc115.code);
  });
});

// Next.js compiles with its own swc, which since 16.4 runs the 1.16 build
// and not the 1.15 one; the 1.16 build has to print there what it prints on
// @swc/core 1.16.
describe('in the swc Next.js ships', () => {
  const nextSwc = require('next/dist/build/swc');
  const nextVersion = require('next/package.json').version;

  it(`rejects the 1.15 build (next ${nextVersion})`, async () => {
    await nextSwc.loadBindings();
    await expect(
      transform(nextSwc, plugin115, 'step', inputs[0][1])
    ).rejects.toThrow(/failed to invoke plugin/);
  });

  describe.each(['step', 'workflow', 'detect'])('%s mode', (mode) => {
    it.each(
      inputs
    )('%s: the 1.16 build prints what it prints on @swc/core 1.16', async (_, file) => {
      await nextSwc.loadBindings();
      const [inNext, onSwc116] = await Promise.all([
        transform(nextSwc, plugin116, mode, file),
        transform(swc116, plugin116, mode, file),
      ]);
      expect(inNext.code).toBe(onSwc116.code);
    });
  });
});
