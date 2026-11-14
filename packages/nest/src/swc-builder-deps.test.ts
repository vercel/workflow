import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeSwcBuilderProblems,
  detectPackageManager,
  devInstallCommand,
  inspectSwcBuilderPackages,
  isSupportedSwcCoreVersion,
  SWC_CORE_INSTALL_SPEC,
} from './swc-builder-deps.js';

/** Write a package into `nodeModules` and return its directory. */
function installFake(
  nodeModules: string,
  pkg: string,
  version = '1.0.0'
): string {
  const dir = join(nodeModules, pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: pkg, version, main: 'index.js' })
  );
  writeFileSync(join(dir, 'index.js'), '');
  return dir;
}

/** Symlink `target` to `nodeModules/<pkg>`, the way pnpm links packages. */
function link(nodeModules: string, pkg: string, target: string): void {
  const dir = join(nodeModules, pkg);
  mkdirSync(dirname(dir), { recursive: true });
  symlinkSync(target, dir, 'dir');
}

let appDir: string | undefined;

function createApp(): string {
  appDir = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-nest-swc-')));
  writeFileSync(join(appDir, 'package.json'), '{"name":"app"}');
  return appDir;
}

afterEach(() => {
  if (appDir) rmSync(appDir, { recursive: true, force: true });
  appDir = undefined;
});

describe('isSupportedSwcCoreVersion', () => {
  it.each([
    ['1.15.0', true],
    ['1.15.3', true],
    ['1.15.18', true],
    ['1.15.18-nightly-20260101.1', true],
    ['1.16.0', false],
    ['1.16.22', false],
    ['1.14.0', false],
    ['1.150.0', false],
    ['2.15.0', false],
    ['unknown', false],
  ])('%s -> %s', (version, supported) => {
    expect(isSupportedSwcCoreVersion(version)).toBe(supported);
  });
});

describe('inspectSwcBuilderPackages', () => {
  it('reports @swc/core 1.16 at the project root, not the 1.15 copy nested under @workflow/nest (npm, yarn)', () => {
    // The layout `npm i -D @swc/cli @swc/core` produces today: the app's
    // @swc/core 1.16 is hoisted, and @workflow/nest keeps its own 1.15 copy.
    const dir = createApp();
    const nm = join(dir, 'node_modules');
    installFake(nm, '@swc/cli', '0.8.2');
    const core = installFake(nm, '@swc/core', '1.16.22');
    installFake(
      join(nm, '@workflow', 'nest', 'node_modules'),
      '@swc/core',
      '1.15.3'
    );
    expect(inspectSwcBuilderPackages(dir)).toEqual({
      cli: true,
      core: { state: 'unsupported', version: '1.16.22', path: core },
    });
  });

  it('reports both packages missing when neither is installed', () => {
    expect(inspectSwcBuilderPackages(createApp())).toEqual({
      cli: false,
      core: { state: 'missing' },
    });
  });

  it('reports @swc/core hoisted to the project root without @swc/cli', () => {
    // `@swc/core` is a dependency of `@workflow/nest` and can end up hoisted
    // (yarn classic does this), and `@swc/cli` loads that copy once added.
    const dir = createApp();
    const core = installFake(join(dir, 'node_modules'), '@swc/core', '1.15.3');
    expect(inspectSwcBuilderPackages(dir)).toEqual({
      cli: false,
      core: { state: 'supported', version: '1.15.3', path: core },
    });
  });

  it('accepts @swc/core 1.15 at the project root', () => {
    const dir = createApp();
    const nm = join(dir, 'node_modules');
    installFake(nm, '@swc/cli', '0.8.2');
    const core = installFake(nm, '@swc/core', '1.15.18');
    expect(inspectSwcBuilderPackages(dir)).toEqual({
      cli: true,
      core: { state: 'supported', version: '1.15.18', path: core },
    });
  });

  it('follows pnpm symlinks to the @swc/core that @swc/cli resolves', () => {
    const dir = createApp();
    const store = join(dir, 'node_modules', '.pnpm');
    const core116 = installFake(
      join(store, '@swc+core@1.16.22', 'node_modules'),
      '@swc/core',
      '1.16.22'
    );
    const core115 = installFake(
      join(store, '@swc+core@1.15.3', 'node_modules'),
      '@swc/core',
      '1.15.3'
    );
    const cliModules = join(
      store,
      '@swc+cli@0.8.2_@swc+core@1.16.22',
      'node_modules'
    );
    const cli = installFake(cliModules, '@swc/cli', '0.8.2');
    link(cliModules, '@swc/core', core116);
    // @workflow/nest's own 1.15 copy, which must not be what we report.
    const nestModules = join(store, '@workflow+nest@5.1.7', 'node_modules');
    installFake(nestModules, '@workflow/nest', '5.1.7');
    link(nestModules, '@swc/core', core115);
    link(join(dir, 'node_modules'), '@swc/cli', cli);
    link(join(dir, 'node_modules'), '@swc/core', core116);
    link(
      join(dir, 'node_modules'),
      '@workflow/nest',
      join(nestModules, '@workflow', 'nest')
    );

    expect(inspectSwcBuilderPackages(dir)).toEqual({
      cli: true,
      core: { state: 'unsupported', version: '1.16.22', path: core116 },
    });
  });

  it('reports the @swc/core @swc/cli loads when it differs from the root one', () => {
    // npm nests a second copy under @swc/cli when the root one does not
    // satisfy it; that nested copy is what `nest build` runs.
    const dir = createApp();
    const nm = join(dir, 'node_modules');
    const cli = installFake(nm, '@swc/cli', '0.8.2');
    installFake(nm, '@swc/core', '1.15.18');
    const nested = installFake(
      join(cli, 'node_modules'),
      '@swc/core',
      '1.16.22'
    );
    expect(inspectSwcBuilderPackages(dir).core).toEqual({
      state: 'unsupported',
      version: '1.16.22',
      path: nested,
    });
  });

  it('reports @swc/core missing even when @workflow/nest has its own copy', () => {
    const dir = createApp();
    const nm = join(dir, 'node_modules');
    installFake(nm, '@swc/cli', '0.8.2');
    installFake(
      join(nm, '@workflow', 'nest', 'node_modules'),
      '@swc/core',
      '1.15.3'
    );
    expect(inspectSwcBuilderPackages(dir)).toEqual({
      cli: true,
      core: { state: 'missing' },
    });
  });

  it('finds packages hoisted to a monorepo root', () => {
    const dir = createApp();
    installFake(join(dir, 'node_modules'), '@swc/cli', '0.8.2');
    installFake(join(dir, 'node_modules'), '@swc/core', '1.16.0');
    const app = join(dir, 'apps', 'api');
    mkdirSync(app, { recursive: true });
    expect(inspectSwcBuilderPackages(app).core).toMatchObject({
      state: 'unsupported',
      version: '1.16.0',
    });
  });

  it('treats an unreadable @swc/core version as unsupported', () => {
    const dir = createApp();
    const core = join(dir, 'node_modules', '@swc', 'core');
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, 'package.json'), '{not json');
    expect(inspectSwcBuilderPackages(dir).core).toEqual({
      state: 'unsupported',
      version: 'unknown',
      path: core,
    });
  });
});

describe('detectPackageManager', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ])('detects %s as %s, even when run through npx', (lockfile, manager) => {
    const dir = createApp();
    writeFileSync(join(dir, lockfile), '');
    expect(detectPackageManager(dir, 'npm/11.0.0 node/v24.0.0')).toBe(manager);
  });

  it('uses the nearest lockfile above a workspace package', () => {
    const dir = createApp();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const app = join(dir, 'apps', 'api');
    mkdirSync(app, { recursive: true });
    expect(detectPackageManager(app, undefined)).toBe('pnpm');
  });

  it('falls back to the invoking package manager, then npm', () => {
    const dir = createApp();
    expect(detectPackageManager(dir, 'yarn/1.22.22 npm/? node/v24')).toBe(
      'yarn'
    );
    expect(detectPackageManager(dir, 'pnpm/10.0.0 npm/? node/v24')).toBe(
      'pnpm'
    );
    expect(detectPackageManager(dir, undefined)).toBe('npm');
  });
});

describe('describeSwcBuilderProblems', () => {
  it('returns null when both packages are installed and supported', () => {
    expect(
      describeSwcBuilderProblems(
        {
          cli: true,
          core: { state: 'supported', version: '1.15.18', path: '/x' },
        },
        'npm'
      )
    ).toBeNull();
  });

  it('names the installed 1.16 version and gives the pinned install command', () => {
    const message = describeSwcBuilderProblems(
      {
        cli: true,
        core: {
          state: 'unsupported',
          version: '1.16.22',
          path: '/app/node_modules/@swc/core',
        },
      },
      'npm'
    );
    expect(message).toContain('@swc/core 1.16.22 is installed');
    expect(message).toContain('only runs on @swc/core 1.15.x');
    expect(message).toContain('/app/node_modules/@swc/core');
    expect(message?.split('\n').at(-1)).toBe('  npm i -D @swc/core@~1.15.18');
  });

  it('installs both packages, with @swc/core pinned, when both are missing', () => {
    const message = describeSwcBuilderProblems(
      { cli: false, core: { state: 'missing' } },
      'pnpm'
    );
    expect(message).toContain('@swc/cli and @swc/core are not installed');
    expect(message?.split('\n').at(-1)).toBe(
      `  pnpm add -D @swc/cli ${SWC_CORE_INSTALL_SPEC}`
    );
  });

  it('combines a missing @swc/cli with an unsupported @swc/core into one command', () => {
    const message = describeSwcBuilderProblems(
      {
        cli: false,
        core: { state: 'unsupported', version: '1.16.0', path: '/x' },
      },
      'yarn'
    );
    expect(message).toContain('@swc/cli is not installed');
    expect(message).toContain('@swc/core 1.16.0 is installed');
    expect(message?.split('\n').at(-1)).toBe(
      '  yarn add -D @swc/cli @swc/core@~1.15.18'
    );
  });
});

describe('devInstallCommand', () => {
  it.each([
    ['npm', 'npm i -D @swc/core@~1.15.18'],
    ['pnpm', 'pnpm add -D @swc/core@~1.15.18'],
    ['yarn', 'yarn add -D @swc/core@~1.15.18'],
    ['bun', 'bun add -d @swc/core@~1.15.18'],
  ] as const)('%s', (manager, command) => {
    expect(devInstallCommand(manager, [SWC_CORE_INSTALL_SPEC])).toBe(command);
  });
});
