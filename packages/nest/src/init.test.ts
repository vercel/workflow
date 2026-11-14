import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
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
  appDir = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-nest-init-')));
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
    pluginPath: () => PLUGIN_PATH,
    log: (message) => lines.push(message),
  });
  return { code, output: lines.join('\n') };
}

afterEach(() => {
  failInspect.value = false;
  rmSync(appDir, { recursive: true, force: true });
});

describe('runInit', () => {
  it('writes .swcrc and warns about @swc/core 1.16 with the pinned install command', () => {
    createApp({ cli: '0.8.2', core: '1.16.22' });
    const { code, output } = init();
    expect(code).toBe(0);
    expect(readFileSync(join(appDir, '.swcrc'), 'utf-8')).toContain(
      PLUGIN_PATH
    );
    expect(output).toContain('@swc/core 1.16.22 is installed');
    expect(output).toContain(join(appDir, 'node_modules', '@swc', 'core'));
    expect(output).toContain('\n  npm i -D @swc/core@~1.15.18\n');
    // The warning comes before the next steps, which still print.
    expect(output.indexOf('1.16.22')).toBeLessThan(
      output.indexOf('Next steps')
    );
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
    createApp({ cli: '0.8.2', core: '1.16.22' });
    rmSync(join(appDir, 'package-lock.json'));
    writeFileSync(join(appDir, 'pnpm-lock.yaml'), '');
    expect(init().output).toContain('\n  pnpm add -D @swc/core@~1.15.18\n');
  });

  it('warns when .swcrc is already configured (the `init` from the docs, run twice)', () => {
    createApp({ cli: '0.8.2', core: '1.16.22' });
    expect(init().code).toBe(0);
    const { code, output } = init();
    expect(code).toBe(0);
    expect(output).toContain('already configured');
    expect(output).toContain('@swc/core 1.16.22 is installed');
  });

  it('warns with --force (the `prebuild` script from the docs)', () => {
    createApp({ cli: '0.8.2', core: '1.16.22' });
    init();
    const { code, output } = init(true);
    expect(code).toBe(0);
    expect(output).toContain('@swc/core 1.16.22 is installed');
  });

  it('warns and still exits 1 when .swcrc exists without the plugin', () => {
    createApp({ cli: '0.8.2', core: '1.16.22' });
    writeFileSync(join(appDir, '.swcrc'), '{}');
    const { code, output } = init();
    expect(code).toBe(1);
    expect(output).toContain('without the workflow plugin');
    expect(output).toContain('@swc/core 1.16.22 is installed');
    expect(readFileSync(join(appDir, '.swcrc'), 'utf-8')).toBe('{}');
  });

  it('still writes .swcrc when the SWC package check throws', () => {
    createApp({ cli: '0.8.2', core: '1.16.22' });
    failInspect.value = true;
    const { code, output } = init();
    expect(code).toBe(0);
    expect(existsSync(join(appDir, '.swcrc'))).toBe(true);
    expect(output).not.toContain('⚠');
    expect(output).toContain('Next steps');
  });
});
