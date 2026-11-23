import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

const failInspect = vi.hoisted(() => ({ value: false }));
vi.mock('./swc-builder-deps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./swc-builder-deps.js')>();
  return {
    ...actual,
    inspectSwcBuilderPackages: (workingDir: string) => {
      if (failInspect.value) throw new Error('EACCES');
      return actual.inspectSwcBuilderPackages(workingDir);
    },
  };
});

const { runInit } = await import('./init.js');

const PLUGIN_PATH = '/plugins/swc_plugin_workflow.wasm';
const PLUGIN_PATH_SWC116 = '/plugins/swc_plugin_workflow_swc116.wasm';

/** Where each `@workflow/swc-plugin` export resolves, as `cli.ts` would. */
function resolvePlugin(specifier: string): string {
  if (specifier === '@workflow/swc-plugin') return PLUGIN_PATH;
  if (specifier === '@workflow/swc-plugin/swc-1.16') return PLUGIN_PATH_SWC116;
  throw new Error(`unexpected plugin export ${specifier}`);
}

/** The workflow plugin path the generated .swcrc points at. */
function swcrcPluginPath(): string {
  const swcrc = JSON.parse(readFileSync(join(appDir, '.swcrc'), 'utf-8'));
  const entries = swcrc.jsc.experimental.plugins as [string, unknown][];
  const workflow = entries.filter(([path]) =>
    path.includes('swc_plugin_workflow')
  );
  expect(workflow).toHaveLength(1);
  return workflow[0][0];
}

function installFake(nodeModules: string, pkg: string, version: string): void {
  const dir = join(nodeModules, pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: pkg, version })
  );
}

let appDir: string;

/**
 * An app laid out the way `npm i workflow @workflow/nest` plus the given SWC
 * packages leave it: @workflow/nest always carries its own @swc/core 1.15.
 */
function createApp(swc: { cli?: string; core?: string }): string {
  // pathe form (forward slashes), as the warning prints paths; realpathSync
  // keeps backslashes on Windows.
  appDir = normalize(
    realpathSync(mkdtempSync(join(tmpdir(), 'workflow-nest-init-')))
  );
  writeFileSync(join(appDir, 'package.json'), '{"name":"app"}');
  writeFileSync(join(appDir, 'package-lock.json'), '{}');
  const nm = join(appDir, 'node_modules');
  installFake(
    join(nm, '@workflow', 'nest', 'node_modules'),
    '@swc/core',
    '1.15.3'
  );
  if (swc.cli) installFake(nm, '@swc/cli', swc.cli);
  if (swc.core) installFake(nm, '@swc/core', swc.core);
  return appDir;
}

function init(force = false): { code: number; output: string } {
  const lines: string[] = [];
  const code = runInit({
    workingDir: appDir,
    moduleType: 'es6',
    force,
    pluginPath: resolvePlugin,
    log: (message) => lines.push(message),
  });
  return { code, output: lines.join('\n') };
}

afterEach(() => {
  failInspect.value = false;
  rmSync(appDir, { recursive: true, force: true });
});

describe('runInit', () => {
  it('writes .swcrc and warns about @swc/core 1.17 with the pinned install command', () => {
    createApp({ cli: '0.8.2', core: '1.17.0' });
    const { code, output } = init();
    expect(code).toBe(0);
    expect(readFileSync(join(appDir, '.swcrc'), 'utf-8')).toContain(
      PLUGIN_PATH
    );
    expect(output).toContain('@swc/core 1.17.0 is installed');
    expect(output).toContain(join(appDir, 'node_modules', '@swc', 'core'));
    expect(output).toContain('\n  npm i -D @swc/core@~1.15.18\n');
    // The warning comes before the next steps, which still print.
    expect(output.indexOf('1.17.0')).toBeLessThan(output.indexOf('Next steps'));
  });

  it('writes the 1.16 plugin build and does not warn when @swc/core 1.16 is installed', () => {
    createApp({ cli: '0.8.2', core: '1.16.22' });
    const { code, output } = init();
    expect(code).toBe(0);
    expect(output).not.toContain('⚠');
    expect(output).toContain(`Plugin path: ${PLUGIN_PATH_SWC116}`);
    expect(swcrcPluginPath()).toBe(PLUGIN_PATH_SWC116);
  });

  it('writes the 1.15 plugin build when @swc/core 1.15 is installed', () => {
    createApp({ cli: '0.8.2', core: '1.15.47' });
    init();
    expect(swcrcPluginPath()).toBe(PLUGIN_PATH);
  });

  it('writes the 1.15 plugin build when @swc/core is missing or unsupported', () => {
    createApp({ cli: '0.8.2' });
    init();
    expect(swcrcPluginPath()).toBe(PLUGIN_PATH);
    rmSync(appDir, { recursive: true, force: true });
    createApp({ cli: '0.8.2', core: '1.17.0' });
    init();
    expect(swcrcPluginPath()).toBe(PLUGIN_PATH);
  });

  it('switches .swcrc to the 1.16 build with --force after upgrading @swc/core', () => {
    createApp({ cli: '0.8.2', core: '1.15.47' });
    init();
    expect(swcrcPluginPath()).toBe(PLUGIN_PATH);
    installFake(join(appDir, 'node_modules'), '@swc/core', '1.16.22');
    init(true);
    expect(swcrcPluginPath()).toBe(PLUGIN_PATH_SWC116);
  });

  it('warns without --force when .swcrc points at the build for another @swc/core line', () => {
    // `init` run once on 1.15, then @swc/core upgraded to 1.16 without
    // rerunning it with --force: nest build would fail to invoke the plugin.
    createApp({ cli: '0.8.2', core: '1.15.47' });
    init();
    installFake(join(appDir, 'node_modules'), '@swc/core', '1.16.22');
    const { code, output } = init();
    expect(code).toBe(0);
    expect(output).toContain(
      '.swcrc points at the Workflow SWC plugin built for @swc/core 1.15.x, but @swc/core 1.16.22 is installed'
    );
    expect(output).toContain('npx @workflow/nest init --force');
    expect(swcrcPluginPath()).toBe(PLUGIN_PATH);
  });

  it('warns without --force when a hand-written .swcrc entry names the 1.15 build on @swc/core 1.16', () => {
    // swc resolves the package's main export, the 1.15 build.
    createApp({ cli: '0.8.2', core: '1.16.22' });
    writeFileSync(
      join(appDir, '.swcrc'),
      JSON.stringify({
        jsc: {
          experimental: {
            plugins: [['@workflow/swc-plugin', { mode: 'step' }]],
          },
        },
      })
    );
    const { code, output } = init();
    expect(code).toBe(0);
    expect(output).toContain(
      'points at the Workflow SWC plugin built for @swc/core 1.15.x, but @swc/core 1.16.22 is installed'
    );
  });

  it('does not warn about the build for a .swcrc entry it cannot place', () => {
    createApp({ cli: '0.8.2', core: '1.16.22' });
    writeFileSync(
      join(appDir, '.swcrc'),
      JSON.stringify({
        jsc: {
          experimental: {
            plugins: [['/vendor/swc-plugin-workflow/custom.wasm', {}]],
          },
        },
      })
    );
    const { code, output } = init();
    expect(code).toBe(0);
    expect(output).not.toContain('⚠');
  });

  it('exits 1 without crashing on a .swcrc that is not valid JSON', () => {
    createApp({ cli: '0.8.2', core: '1.16.22' });
    writeFileSync(join(appDir, '.swcrc'), '{ "jsc": ');
    const { code, output } = init();
    expect(code).toBe(1);
    expect(output).toContain(
      '.swcrc already exists without the workflow plugin'
    );
    expect(output).not.toContain('points at the Workflow SWC plugin');
  });

  it('does not warn without --force when .swcrc already points at the matching build', () => {
    createApp({ cli: '0.8.2', core: '1.16.22' });
    init();
    const { output } = init();
    expect(output).not.toContain('⚠');
  });

  it('does not warn when @swc/core 1.15 is installed', () => {
    createApp({ cli: '0.8.2', core: '1.15.18' });
    const { code, output } = init();
    expect(code).toBe(0);
    expect(output).not.toContain('⚠');
    expect(output).toContain('Next steps');
  });

  it('warns that @swc/core is missing instead of reporting the copy under @workflow/nest', () => {
    createApp({ cli: '0.8.2' });
    const { output } = init();
    expect(output).toContain('@swc/core is not installed');
    expect(output).not.toContain('1.15.3');
    expect(output).toContain('\n  npm i -D @swc/core@~1.15.18\n');
  });

  it('warns about both packages when neither is installed', () => {
    createApp({});
    const { output } = init();
    expect(output).toContain('@swc/cli and @swc/core are not installed');
    expect(output).toContain('\n  npm i -D @swc/cli @swc/core@~1.15.18\n');
  });

  it('uses the install command of the project package manager', () => {
    createApp({ cli: '0.8.2', core: '1.17.0' });
    rmSync(join(appDir, 'package-lock.json'));
    writeFileSync(join(appDir, 'pnpm-lock.yaml'), '');
    expect(init().output).toContain('\n  pnpm add -D @swc/core@~1.15.18\n');
  });

  it('warns in an npm workspace whose root @nestjs/cli loads @swc/core 1.17, with a fix for the root', () => {
    // The app follows the docs (@swc/core 1.15), but `nest build` runs the
    // root @nestjs/cli, which loads the root's @swc/cli and @swc/core 1.17.
    createApp({ cli: '0.8.1', core: '1.15.47' });
    const root = appDir;
    rmSync(join(root, 'package-lock.json'));
    const app = join(root, 'apps', 'api');
    mkdirSync(app, { recursive: true });
    renameSync(join(root, 'node_modules'), join(app, 'node_modules'));
    writeFileSync(join(app, 'package.json'), '{"name":"api"}');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*'] })
    );
    writeFileSync(join(root, 'package-lock.json'), '{}');
    const rootModules = join(root, 'node_modules');
    installFake(rootModules, '@nestjs/cli', '12.0.13');
    installFake(rootModules, '@swc/cli', '0.8.2');
    installFake(rootModules, '@swc/core', '1.17.0');

    const lines: string[] = [];
    const code = runInit({
      workingDir: app,
      moduleType: 'es6',
      force: false,
      pluginPath: resolvePlugin,
      log: (message) => lines.push(message),
    });
    const output = lines.join('\n');
    expect(code).toBe(0);
    expect(existsSync(join(app, '.swcrc'))).toBe(true);
    expect(output).toContain('@swc/core 1.17.0 is installed');
    expect(output).toContain(join(rootModules, '@swc', 'core'));
    expect(output).toContain(
      `through @nestjs/cli in ${root}, outside this app`
    );
    expect(output).toContain('\n  cd ../.. && npm i -D @swc/core@~1.15.18\n');
  });

  it('writes the 1.16 build in an npm workspace whose root @nestjs/cli loads @swc/core 1.16, though the app has 1.15', () => {
    // The plugin build has to match the @swc/core `nest build` loads, which is
    // the root's (through the root @nestjs/cli), not the app's own.
    createApp({ cli: '0.8.1', core: '1.15.47' });
    const root = appDir;
    rmSync(join(root, 'package-lock.json'));
    const app = join(root, 'apps', 'api');
    mkdirSync(app, { recursive: true });
    renameSync(join(root, 'node_modules'), join(app, 'node_modules'));
    writeFileSync(join(app, 'package.json'), '{"name":"api"}');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*'] })
    );
    writeFileSync(join(root, 'package-lock.json'), '{}');
    const rootModules = join(root, 'node_modules');
    installFake(rootModules, '@nestjs/cli', '12.0.13');
    installFake(rootModules, '@swc/cli', '0.8.2');
    installFake(rootModules, '@swc/core', '1.16.22');

    const lines: string[] = [];
    runInit({
      workingDir: app,
      moduleType: 'es6',
      force: false,
      pluginPath: resolvePlugin,
      log: (message) => lines.push(message),
    });
    expect(lines.join('\n')).not.toContain('⚠');
    const swcrc = JSON.parse(readFileSync(join(app, '.swcrc'), 'utf-8'));
    expect(swcrc.jsc.experimental.plugins[0][0]).toBe(PLUGIN_PATH_SWC116);
  });

  it('warns when .swcrc is already configured (the `init` from the docs, run twice)', () => {
    createApp({ cli: '0.8.2', core: '1.17.0' });
    expect(init().code).toBe(0);
    const { code, output } = init();
    expect(code).toBe(0);
    expect(output).toContain('already configured');
    expect(output).toContain('@swc/core 1.17.0 is installed');
  });

  it('warns with --force (the `prebuild` script from the docs)', () => {
    createApp({ cli: '0.8.2', core: '1.17.0' });
    init();
    const { code, output } = init(true);
    expect(code).toBe(0);
    expect(output).toContain('@swc/core 1.17.0 is installed');
  });

  it('warns and still exits 1 when .swcrc exists without the plugin', () => {
    createApp({ cli: '0.8.2', core: '1.17.0' });
    writeFileSync(join(appDir, '.swcrc'), '{}');
    const { code, output } = init();
    expect(code).toBe(1);
    expect(output).toContain('without the workflow plugin');
    expect(output).toContain('@swc/core 1.17.0 is installed');
    expect(readFileSync(join(appDir, '.swcrc'), 'utf-8')).toBe('{}');
  });

  it('falls back to the 1.15 build when the SWC package check throws', () => {
    // Without the check there is no installed version to match, so init
    // writes what it wrote before there were two builds.
    createApp({ cli: '0.8.2', core: '1.16.22' });
    failInspect.value = true;
    init();
    expect(swcrcPluginPath()).toBe(PLUGIN_PATH);
  });

  it('still writes .swcrc when the SWC package check throws', () => {
    createApp({ cli: '0.8.2', core: '1.17.0' });
    failInspect.value = true;
    const { code, output } = init();
    expect(code).toBe(0);
    expect(existsSync(join(appDir, '.swcrc'))).toBe(true);
    expect(output).not.toContain('⚠');
    expect(output).toContain('Next steps');
  });
});
