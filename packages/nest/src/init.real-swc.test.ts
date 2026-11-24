/**
 * `init` against a real `@swc/core`: the app's `node_modules` links the real
 * `@swc/core` 1.15 or 1.16 next to an `@swc/cli`, as an npm install lays them
 * out, `init` writes `.swcrc` with the real `@workflow/swc-plugin` build it
 * resolves, and a workflow file is compiled with that `.swcrc` by the same
 * `@swc/core`. That compile is the step `nest build` fails at ("failed to
 * invoke plugin") when the build doesn't match the `@swc/core`.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from './init.js';

const require = createRequire(import.meta.url);

/** The directory of an installed package, following pnpm's symlinks. */
function packageDir(pkg: string): string {
  return realpathSync(dirname(require.resolve(`${pkg}/package.json`)));
}

const SWC_CORE = {
  '1.15': packageDir('@swc/core'),
  '1.16': packageDir('swc-core-1-16'),
} as const;

const WORKFLOW = `export async function addTen(n: number) {
  'use step';
  return n + 10;
}

export async function addTenWorkflow(n: number) {
  'use workflow';
  return await addTen(n);
}
`;

let appDir: string | undefined;

function createApp(line: keyof typeof SWC_CORE): string {
  appDir = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-nest-real-swc-')));
  writeFileSync(join(appDir, 'package.json'), '{"name":"app"}');
  writeFileSync(join(appDir, 'package-lock.json'), '{}');
  const swc = join(appDir, 'node_modules', '@swc');
  mkdirSync(swc, { recursive: true });
  // Only its manifest: the real @swc/cli in this workspace would resolve its
  // own @swc/core from the pnpm store instead of the app's, and the compile
  // below calls @swc/core directly, as @swc/cli does for nest build.
  mkdirSync(join(swc, 'cli'));
  writeFileSync(
    join(swc, 'cli', 'package.json'),
    JSON.stringify({ name: '@swc/cli', version: '0.8.2' })
  );
  symlinkSync(SWC_CORE[line], join(swc, 'core'), 'dir');
  mkdirSync(join(appDir, 'src', 'workflows'), { recursive: true });
  writeFileSync(join(appDir, 'src', 'workflows', 'add.ts'), WORKFLOW);
  return appDir;
}

function init(): string {
  const lines: string[] = [];
  const code = runInit({
    workingDir: appDir as string,
    moduleType: 'commonjs',
    force: true,
    // The default is what `cli.ts` resolved before there were two builds.
    pluginPath: (specifier = '@workflow/swc-plugin') =>
      require.resolve(specifier),
    log: (message) => lines.push(message),
  });
  expect(code).toBe(0);
  return lines.join('\n');
}

/** Compile the workflow file with the app's `@swc/core` and its `.swcrc`. */
function compile(): Promise<{ code: string }> {
  const dir = appDir as string;
  const swc = require(join(dir, 'node_modules', '@swc', 'core'));
  return swc.transformFile(join(dir, 'src', 'workflows', 'add.ts'), {
    cwd: dir,
    swcrc: true,
  });
}

function swcrcPluginPath(): string {
  const swcrc = JSON.parse(
    readFileSync(join(appDir as string, '.swcrc'), 'utf-8')
  );
  return swcrc.jsc.experimental.plugins[0][0];
}

afterEach(() => {
  if (appDir) rmSync(appDir, { recursive: true, force: true });
  appDir = undefined;
});

describe('init with real SWC packages', () => {
  it.each([
    ['1.15', 'swc_plugin_workflow.wasm'],
    ['1.16', 'swc_plugin_workflow_swc116.wasm'],
  ] as const)('on @swc/core %s, writes %s and the workflow compiles with it', async (line, wasm) => {
    createApp(line);
    const output = init();
    expect(output).not.toContain('⚠');
    expect(swcrcPluginPath().replace(/\\/g, '/').split('/').pop()).toBe(wasm);
    const { code } = await compile();
    expect(code).toContain('__internal_workflows');
    expect(code).toMatch(/"addTen":\{"stepId":"step\/\/[^"]+\/\/addTen"\}/);
  });

  it('fails to compile on @swc/core 1.16 with the 1.15 build, as nest build did before init picked the build', async () => {
    createApp('1.16');
    init();
    const swcrcPath = join(appDir as string, '.swcrc');
    const swcrc = JSON.parse(readFileSync(swcrcPath, 'utf-8'));
    swcrc.jsc.experimental.plugins[0][0] = require.resolve(
      '@workflow/swc-plugin'
    );
    writeFileSync(swcrcPath, JSON.stringify(swcrc));
    await expect(compile()).rejects.toThrow(/failed to invoke plugin/);
  });
});
