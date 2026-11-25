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
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeSwcBuilderProblems,
  detectPackageManager,
  devInstallCommand,
  inspectSwcBuilderPackages,
  isSupportedSwcCoreVersion,
  SUPPORTED_SWC_CORE_LINE,
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
  // pathe form (forward slashes), as inspectSwcBuilderPackages returns paths;
  // realpathSync keeps backslashes on Windows.
  appDir = normalize(
    realpathSync(mkdtempSync(join(tmpdir(), 'workflow-nest-swc-')))
  );
  writeFileSync(join(appDir, 'package.json'), '{"name":"app"}');
  return appDir;
}

afterEach(() => {
  if (appDir) rmSync(appDir, { recursive: true, force: true });
  appDir = undefined;
});

describe('supported @swc/core line', () => {
  const PINS =
    'SUPPORTED_SWC_CORE_LINE and SWC_CORE_INSTALL_SPEC in ' +
    'packages/nest/src/swc-builder-deps.ts, and the pinned @swc/core version ' +
    'in docs/content/docs/v4/getting-started/nestjs.mdx, ' +
    'docs/content/docs/v5/getting-started/nestjs.mdx and ' +
    'packages/nest/README.md, and the @swc/core devDependency in ' +
    'workbench/nest/package.json';

  it('matches the @swc/core that @workflow/nest and its SWC plugin are built against', () => {
    // The catalog version @workflow/nest depends on and @workflow/swc-plugin
    // peers on. If it moves to another minor, `init` would tell users on a
    // working version to install one the plugin no longer runs on.
    const packageJson = createRequire(import.meta.url).resolve(
      '@swc/core/package.json'
    );
    const { version } = JSON.parse(readFileSync(packageJson, 'utf-8'));
    expect(
      isSupportedSwcCoreVersion(version),
      `@workflow/nest depends on @swc/core ${version}, but ` +
        `SUPPORTED_SWC_CORE_LINE is ${SUPPORTED_SWC_CORE_LINE}. Only if the ` +
        'Workflow SWC plugin has been rebuilt for the new @swc/core line, ' +
        `update ${PINS} together. Otherwise, revert the @swc/core catalog ` +
        'bump in pnpm-workspace.yaml.'
    ).toBe(true);
  });

  it('installs a version on the supported line', () => {
    expect(
      SWC_CORE_INSTALL_SPEC.startsWith(
        `@swc/core@~${SUPPORTED_SWC_CORE_LINE}.`
      ),
      `SWC_CORE_INSTALL_SPEC (${SWC_CORE_INSTALL_SPEC}) is not on ` +
        `SUPPORTED_SWC_CORE_LINE (${SUPPORTED_SWC_CORE_LINE}): update ${PINS} ` +
        'together.'
    ).toBe(true);
  });

  it.each([
    'docs/content/docs/v4/getting-started/nestjs.mdx',
    'docs/content/docs/v5/getting-started/nestjs.mdx',
    'packages/nest/README.md',
  ])('%s installs SWC_CORE_INSTALL_SPEC', (file) => {
    const content = readFileSync(
      fileURLToPath(new URL(`../../../${file}`, import.meta.url)),
      'utf-8'
    );
    expect(
      content.includes(SWC_CORE_INSTALL_SPEC),
      `${file} does not contain ${SWC_CORE_INSTALL_SPEC}: update ${PINS} ` +
        'together.'
    ).toBe(true);
  });

  it('workbench/nest/package.json installs SWC_CORE_INSTALL_SPEC', () => {
    // The e2e workbench builds with what the docs tell users to install.
    const { devDependencies } = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../../workbench/nest/package.json', import.meta.url)
        ),
        'utf-8'
      )
    );
    const spec = `@swc/core@${devDependencies?.['@swc/core']}`;
    expect(
      spec,
      `workbench/nest/package.json installs ${spec}, not ` +
        `${SWC_CORE_INSTALL_SPEC}: update ${PINS} together.`
    ).toBe(SWC_CORE_INSTALL_SPEC);
  });
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

/**
 * An npm (or yarn 1) workspace as `npm i` lays it out: the root declares
 * @nestjs/cli and @swc/core 1.16, and the app follows the docs with 1.15.
 * Everything the root declares is hoisted to the root `node_modules`.
 */
function npmWorkspace() {
  const root = createApp();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['apps/*'] })
  );
  const rootModules = join(root, 'node_modules');
  installFake(rootModules, '@nestjs/cli', '12.0.13');
  installFake(rootModules, '@swc/cli', '0.8.2');
  const rootCore = installFake(rootModules, '@swc/core', '1.16.22');
  const app = join(root, 'apps', 'api');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"name":"api"}');
  installFake(join(app, 'node_modules'), '@swc/cli', '0.8.1');
  const appCore = installFake(
    join(app, 'node_modules'),
    '@swc/core',
    '1.15.47'
  );
  return { root, app, rootCore, appCore };
}

/**
 * The same workspace under pnpm: packages live in the root's `.pnpm` store
 * and every `node_modules` entry is a symlink. The root @nestjs/cli's
 * @swc/cli and @swc/core peers are linked to the root's 1.16 copy.
 */
function pnpmWorkspace() {
  const root = createApp();
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
  const store = join(root, 'node_modules', '.pnpm');
  const core = (version: string) =>
    installFake(
      join(store, `@swc+core@${version}`, 'node_modules'),
      '@swc/core',
      version
    );
  const core116 = core('1.16.22');
  const core115 = core('1.15.47');
  const cli = (version: string, coreDir: string, coreVersion: string) => {
    const modules = join(
      store,
      `@swc+cli@${version}_@swc+core@${coreVersion}`,
      'node_modules'
    );
    link(modules, '@swc/core', coreDir);
    return installFake(modules, '@swc/cli', version);
  };
  const cli116 = cli('0.8.2', core116, '1.16.22');
  const cli115 = cli('0.8.1', core115, '1.15.47');
  const nestModules = join(
    store,
    '@nestjs+cli@12.0.13_@swc+cli@0.8.2_@swc+core@1.16.22',
    'node_modules'
  );
  const nestCli = installFake(nestModules, '@nestjs/cli', '12.0.13');
  link(nestModules, '@swc/cli', cli116);
  link(nestModules, '@swc/core', core116);
  link(join(root, 'node_modules'), '@nestjs/cli', nestCli);
  const app = join(root, 'apps', 'api');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"name":"api"}');
  link(join(app, 'node_modules'), '@swc/cli', cli115);
  link(join(app, 'node_modules'), '@swc/core', core115);
  return { root, app, core116, core115, store };
}

describe('inspectSwcBuilderPackages in workspaces', () => {
  it('reports the 1.16 @swc/core the root @nestjs/cli loads, not the app 1.15 (npm workspace)', () => {
    const { root, app, rootCore } = npmWorkspace();
    expect(inspectSwcBuilderPackages(app)).toEqual({
      cli: true,
      core: { state: 'unsupported', version: '1.16.22', path: rootCore },
      outside: {
        dir: root,
        relative: '../..',
        workspaceRoot: true,
        yarnBerry: false,
      },
    });
  });

  it('reports the 1.16 @swc/core the root @nestjs/cli loads, not the app 1.15 (pnpm workspace)', () => {
    const { root, app, core116 } = pnpmWorkspace();
    expect(inspectSwcBuilderPackages(app)).toEqual({
      cli: true,
      core: { state: 'unsupported', version: '1.16.22', path: core116 },
      outside: {
        dir: root,
        relative: '../..',
        workspaceRoot: true,
        yarnBerry: false,
      },
    });
  });

  it('uses the app @nestjs/cli when the app has its own (pnpm workspace)', () => {
    const { app, store, core115 } = pnpmWorkspace();
    const nestModules = join(
      store,
      '@nestjs+cli@12.0.13_@swc+cli@0.8.1_@swc+core@1.15.47',
      'node_modules'
    );
    const nestCli = installFake(nestModules, '@nestjs/cli', '12.0.13');
    link(nestModules, '@swc/cli', join(app, 'node_modules', '@swc', 'cli'));
    link(join(app, 'node_modules'), '@nestjs/cli', nestCli);
    expect(inspectSwcBuilderPackages(app)).toEqual({
      cli: true,
      core: { state: 'supported', version: '1.15.47', path: core115 },
    });
  });

  it('reports @swc/cli missing when the root @nestjs/cli cannot reach one, even though the app has one', () => {
    // nest build would fail with "Failed to load @swc/cli": the app's copy is
    // not on @nestjs/cli's resolution path.
    const { root, app } = npmWorkspace();
    rmSync(join(root, 'node_modules', '@swc'), { recursive: true });
    const status = inspectSwcBuilderPackages(app);
    expect(status).toEqual({
      cli: false,
      core: { state: 'missing' },
      outside: {
        dir: root,
        relative: '../..',
        workspaceRoot: true,
        yarnBerry: false,
      },
    });
    const message = describeSwcBuilderProblems(status, 'npm');
    expect(message).toContain(
      '@swc/cli and @swc/core are not installed where @nestjs/cli can load them'
    );
    expect(message?.split('\n').at(-1)).toBe(
      '  cd ../.. && npm i -D @swc/cli @swc/core@~1.15.18'
    );
  });

  it('reports only @swc/cli missing when the root has @swc/core 1.15 but no @swc/cli', () => {
    const { root, app } = npmWorkspace();
    rmSync(join(root, 'node_modules', '@swc', 'cli'), { recursive: true });
    const rootCore = installFake(
      join(root, 'node_modules'),
      '@swc/core',
      '1.15.47'
    );
    const status = inspectSwcBuilderPackages(app);
    expect(status).toMatchObject({
      cli: false,
      core: { state: 'supported', version: '1.15.47', path: rootCore },
      outside: { dir: root },
    });
    const message = describeSwcBuilderProblems(status, 'npm');
    expect(message).toContain(
      '@swc/cli is not installed where @nestjs/cli can load it'
    );
    expect(message?.split('\n').at(-1)).toBe('  cd ../.. && npm i -D @swc/cli');
  });

  it('resolves from the app only when no @nestjs/cli is installed at all', () => {
    const { root, app, appCore } = npmWorkspace();
    rmSync(join(root, 'node_modules', '@nestjs'), { recursive: true });
    expect(inspectSwcBuilderPackages(app)).toEqual({
      cli: true,
      core: { state: 'supported', version: '1.15.47', path: appCore },
    });
  });

  it('points the fix at the root @nestjs/cli when no @swc/cli is installed', () => {
    const { root, app } = npmWorkspace();
    rmSync(join(root, 'node_modules', '@swc'), { recursive: true });
    rmSync(join(app, 'node_modules'), { recursive: true });
    expect(inspectSwcBuilderPackages(app)).toMatchObject({
      cli: false,
      core: { state: 'missing' },
      outside: { dir: root, relative: '../..' },
    });
  });

  it('tells the user to pin @swc/core where @nestjs/cli is installed (npm workspace)', () => {
    const { root, app } = npmWorkspace();
    const message = describeSwcBuilderProblems(
      inspectSwcBuilderPackages(app),
      'npm'
    );
    expect(message).toContain('@swc/core 1.16.22 is installed');
    expect(message).toContain(
      `\`nest build\` loads them through @nestjs/cli in ${root}, outside this app`
    );
    expect(message?.split('\n').at(-1)).toBe(
      '  cd ../.. && npm i -D @swc/core@~1.15.18'
    );
  });

  it('tells the user to pin @swc/core where @nestjs/cli is installed (pnpm workspace)', () => {
    const { app } = pnpmWorkspace();
    const message = describeSwcBuilderProblems(
      inspectSwcBuilderPackages(app),
      'pnpm'
    );
    expect(message?.split('\n').at(-1)).toBe(
      '  cd ../.. && pnpm add -D -w @swc/core@~1.15.18'
    );
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

describe('devInstallCommand at a workspace root', () => {
  it.each([
    ['npm', {}, 'cd ../.. && npm i -D @swc/core@~1.15.18'],
    ['pnpm', {}, 'cd ../.. && pnpm add -D -w @swc/core@~1.15.18'],
    ['yarn', {}, 'cd ../.. && yarn add -D -W @swc/core@~1.15.18'],
    ['yarn', { yarnBerry: true }, 'cd ../.. && yarn add -D @swc/core@~1.15.18'],
    ['bun', {}, 'cd ../.. && bun add -d @swc/core@~1.15.18'],
  ] as const)('%s %o', (manager, extra, command) => {
    expect(
      devInstallCommand(manager, [SWC_CORE_INSTALL_SPEC], {
        cd: '../..',
        workspaceRoot: true,
        ...extra,
      })
    ).toBe(command);
  });

  it('quotes a folder the shell would split', () => {
    expect(
      devInstallCommand('npm', ['@swc/cli'], { cd: "../my app's root" })
    ).toBe(`cd '../my app'\\''s root' && npm i -D @swc/cli`);
  });
});
