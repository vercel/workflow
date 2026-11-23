import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'pathe';

/**
 * The `@swc/core` minor lines the Workflow SWC plugin has a build for: the
 * `@workflow/swc-plugin` export to load on each, and the wasm file that export
 * points at. A build only runs on its own line; on any other, `nest build`
 * fails every file with "failed to invoke plugin ... Failed to deserialize
 * program received from host".
 */
export const SWC_PLUGIN_BUILDS = [
  {
    line: '1.15',
    specifier: '@workflow/swc-plugin',
    wasm: 'swc_plugin_workflow.wasm',
  },
  {
    line: '1.16',
    specifier: '@workflow/swc-plugin/swc-1.16',
    wasm: 'swc_plugin_workflow_swc116.wasm',
  },
] as const;

export type SwcPluginBuild = (typeof SWC_PLUGIN_BUILDS)[number];

/** The build used when the app's `@swc/core` is missing or unsupported. */
export const DEFAULT_SWC_PLUGIN_BUILD: SwcPluginBuild = SWC_PLUGIN_BUILDS[0];

/** "1.15.x or 1.16.x", for messages. */
export const SUPPORTED_SWC_CORE_LINES_TEXT = SWC_PLUGIN_BUILDS.map(
  (build) => `${build.line}.x`
).join(' or ');

/**
 * What to install to get a supported `@swc/core`. 1.15.18 is the lowest
 * version the NestJS CLI 12 peer range (`^1.15.18`) accepts, and `~` keeps the
 * package manager on 1.15.x, the line the 1.15 build (the package's main
 * export) has run on longest.
 */
export const SWC_CORE_INSTALL_SPEC = '@swc/core@~1.15.18';

export type SwcCoreStatus =
  | { state: 'missing' }
  | { state: 'supported' | 'unsupported'; version: string; path: string };

/**
 * The packages the NestJS CLI's SWC builder (`compilerOptions.builder: "swc"`)
 * loads from the application. They are optional peers of `@workflow/nest`, so
 * package managers do not install them; the application has to list them.
 */
export interface SwcBuilderStatus {
  /** Whether the application has `@swc/cli`. */
  cli: boolean;
  /** The `@swc/core` that `@swc/cli` loads when `nest build` runs. */
  core: SwcCoreStatus;
  /**
   * Set when `nest build` loads the SWC packages from outside the
   * application: `@nestjs/cli` is installed in another folder (a workspace
   * root, say), and SWC packages installed in the application do not reach
   * it. Fixes have to be installed there.
   */
  outside?: OutsideInstall;
}

export interface OutsideInstall {
  /** The folder whose `node_modules` holds `@nestjs/cli`. */
  dir: string;
  /** `dir` relative to the application, for a `cd` the user can paste. */
  relative: string;
  /** `dir` is a workspace root, where pnpm needs `-w` and yarn 1 `-W`. */
  workspaceRoot: boolean;
  /** `dir` uses Yarn 2+ (it has a `.yarnrc.yml`), which takes no `-W`. */
  yarnBerry: boolean;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface FoundPackage {
  /** Real path of the package's `package.json`. */
  packageJson: string;
  /**
   * The folder whose `node_modules` holds the package (before following
   * symlinks), or `null` under Yarn PnP, which has no `node_modules`.
   */
  installDir: string | null;
}

/**
 * Find `pkg` as Node would resolve it from a module in `fromDir`, or return
 * `null` when it is not installed.
 */
function findPackage(pkg: string, fromDir: string): FoundPackage | null {
  // Yarn PnP has no node_modules to walk.
  if (process.versions.pnp) {
    try {
      const packageJson = createRequire(join(fromDir, 'noop.js')).resolve(
        `${pkg}/package.json`
      );
      return { packageJson, installDir: null };
    } catch {
      return null;
    }
  }
  // Walk node_modules directly instead of `require.resolve`, which also
  // searches NODE_PATH and can find a copy the application does not have.
  let dir = resolve(fromDir);
  while (true) {
    const candidate = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(candidate)) {
      return { packageJson: realpathSync(candidate), installDir: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isWorkspaceRoot(dir: string): boolean {
  if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
  try {
    const { workspaces } = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf-8')
    );
    return workspaces !== undefined;
  } catch {
    return false;
  }
}

function readVersion(packageJsonPath: string): string {
  try {
    const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The plugin build for an `@swc/core` version, or `undefined` when none runs on it. */
export function swcPluginBuildFor(version: string): SwcPluginBuild | undefined {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return undefined;
  const line = `${match[1]}.${match[2]}`;
  return SWC_PLUGIN_BUILDS.find((build) => build.line === line);
}

export function isSupportedSwcCoreVersion(version: string): boolean {
  return swcPluginBuildFor(version) !== undefined;
}

/**
 * The plugin build a `.swcrc` plugin path points at, from its wasm file name,
 * or `undefined` for a path that names neither (a hand-written entry).
 */
export function swcPluginBuildOfPath(
  pluginPath: string
): SwcPluginBuild | undefined {
  const file = pluginPath.replace(/\\/g, '/').split('/').pop();
  return SWC_PLUGIN_BUILDS.find((build) => build.wasm === file);
}

/**
 * Inspect the SWC packages the NestJS CLI's SWC builder uses for `workingDir`.
 *
 * They are resolved the way `nest build` loads them: `@nestjs/cli` requires
 * `@swc/cli` from its own location, and `@swc/cli` requires `@swc/core` from
 * its own. Only when `@nestjs/cli` is not installed at all is `@swc/cli`
 * resolved from `workingDir`. `@swc/core` is never taken
 * from `@workflow/nest`, whose own dependency is a different copy whenever
 * the application installs another version.
 */
export function inspectSwcBuilderPackages(
  workingDir: string
): SwcBuilderStatus {
  const appDir = resolve(workingDir);
  // nest build loads @swc/cli only from @nestjs/cli's location, so when the
  // app has @nestjs/cli, an @swc/cli it cannot reach does not count, even if
  // the app has one. Without @nestjs/cli there is nothing to follow, and the
  // app is where it will be installed.
  const nestCli = findPackage('@nestjs/cli', appDir);
  const from = nestCli ? dirname(nestCli.packageJson) : appDir;
  const cli = findPackage('@swc/cli', from);
  const core = findPackage('@swc/core', cli ? dirname(cli.packageJson) : from);

  // Where a fix has to go: next to @nestjs/cli.
  const installDir = nestCli?.installDir ?? appDir;
  const outside: OutsideInstall | undefined =
    installDir === appDir
      ? undefined
      : {
          dir: installDir,
          relative: relative(appDir, installDir),
          workspaceRoot: isWorkspaceRoot(installDir),
          yarnBerry: existsSync(join(installDir, '.yarnrc.yml')),
        };

  const status: SwcBuilderStatus = {
    cli: cli !== null,
    core: { state: 'missing' },
    ...(outside ? { outside } : {}),
  };
  if (core) {
    const version = readVersion(core.packageJson);
    status.core = {
      state: isSupportedSwcCoreVersion(version) ? 'supported' : 'unsupported',
      version,
      path: dirname(core.packageJson),
    };
  }
  return status;
}

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

/**
 * Guess the application's package manager from the nearest lockfile, then the
 * invoking package manager. The lockfile wins because `npx` reports itself as
 * npm even inside a pnpm or yarn project.
 */
export function detectPackageManager(
  workingDir: string,
  /** `process.env.npm_config_user_agent` of the invoking package manager. */
  userAgent: string | undefined
): PackageManager {
  let dir = resolve(workingDir);
  while (true) {
    for (const [lockfile, manager] of LOCKFILES) {
      if (existsSync(join(dir, lockfile))) return manager;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const name = userAgent?.split('/')[0];
  if (name === 'pnpm' || name === 'yarn' || name === 'bun') return name;
  return 'npm';
}

export interface InstallTarget {
  /** Run the command in this folder (relative to the application). */
  cd?: string;
  /** The folder is a workspace root: pnpm needs `-w`, yarn 1 `-W`. */
  workspaceRoot?: boolean;
  /** The folder uses Yarn 2+, which has no `-W`. */
  yarnBerry?: boolean;
}

function shellQuote(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

export function devInstallCommand(
  manager: PackageManager,
  packages: readonly string[],
  target: InstallTarget = {}
): string {
  let prefix = {
    npm: 'npm i -D',
    pnpm: 'pnpm add -D',
    yarn: 'yarn add -D',
    bun: 'bun add -d',
  }[manager];
  if (target.workspaceRoot && manager === 'pnpm') prefix += ' -w';
  if (target.workspaceRoot && manager === 'yarn' && !target.yarnBerry) {
    prefix += ' -W';
  }
  const command = `${prefix} ${packages.join(' ')}`;
  return target.cd ? `cd ${shellQuote(target.cd)} && ${command}` : command;
}

/**
 * Describe what is wrong with the application's SWC builder packages, with
 * the command that fixes it, or return `null` when nothing is.
 */
export function describeSwcBuilderProblems(
  status: SwcBuilderStatus,
  manager: PackageManager
): string | null {
  const lines: string[] = [];
  const install: string[] = [];
  const missing: string[] = [];
  if (!status.cli) {
    missing.push('@swc/cli');
    install.push('@swc/cli');
  }
  const { core } = status;
  if (core.state === 'missing') {
    missing.push('@swc/core');
    install.push(SWC_CORE_INSTALL_SPEC);
  }
  if (missing.length > 0) {
    const where = status.outside
      ? ` where @nestjs/cli can load ${missing.length === 1 ? 'it' : 'them'}`
      : '';
    lines.push(
      `⚠ ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} ` +
        `not installed${where}. The NestJS SWC builder needs @swc/cli and ` +
        `@swc/core ${SUPPORTED_SWC_CORE_LINES_TEXT} as dev dependencies.`
    );
  }
  if (core.state === 'unsupported') {
    lines.push(
      `⚠ @swc/core ${core.version} is installed, but the Workflow SWC ` +
        `plugin only runs on @swc/core ${SUPPORTED_SWC_CORE_LINES_TEXT}, so ` +
        '`nest build` fails with "failed to invoke plugin".',
      `  Resolved from: ${core.path}`
    );
    install.push(SWC_CORE_INSTALL_SPEC);
  }
  if (install.length === 0) return null;
  const { outside } = status;
  if (outside) {
    lines.push(
      `  \`nest build\` loads them through @nestjs/cli in ${outside.dir}, ` +
        'outside this app, so SWC packages installed in this app do not ' +
        'reach it. Install them there instead.'
    );
  }
  const target: InstallTarget = outside
    ? {
        cd: outside.relative,
        workspaceRoot: outside.workspaceRoot,
        yarnBerry: outside.yarnBerry,
      }
    : {};
  lines.push(
    '  Fix it with:',
    `  ${devInstallCommand(manager, install, target)}`
  );
  return lines.join('\n');
}
