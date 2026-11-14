import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'pathe';

/**
 * The `@swc/core` minor line the Workflow SWC plugin runs on. On any other
 * line (1.16 included), `nest build` fails every file with "failed to invoke
 * plugin ... Failed to deserialize program received from host".
 */
export const SUPPORTED_SWC_CORE_LINE = '1.15';

/**
 * What to install to get a supported `@swc/core`. 1.15.18 is the lowest
 * version the NestJS CLI 12 peer range (`^1.15.18`) accepts, and `~` keeps the
 * package manager on 1.15.x.
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
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Return the `package.json` path of `pkg` as Node would resolve it from a
 * module in `fromDir`, or `null` when it is not installed.
 */
function findPackageJson(pkg: string, fromDir: string): string | null {
  // Yarn PnP has no node_modules to walk.
  if (process.versions.pnp) {
    try {
      return createRequire(join(fromDir, 'noop.js')).resolve(
        `${pkg}/package.json`
      );
    } catch {
      return null;
    }
  }
  // Walk node_modules directly instead of `require.resolve`, which also
  // searches NODE_PATH and can find a copy the application does not have.
  let dir = resolve(fromDir);
  while (true) {
    const candidate = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
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

export function isSupportedSwcCoreVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  return (
    match !== null && `${match[1]}.${match[2]}` === SUPPORTED_SWC_CORE_LINE
  );
}

/**
 * Inspect the SWC packages the NestJS CLI's SWC builder uses for `workingDir`.
 *
 * `@swc/core` is resolved the way `nest build` loads it: from `@swc/cli` when
 * the application has it, otherwise from `workingDir`. Never from
 * `@workflow/nest`, whose own `@swc/core` dependency is a different copy
 * whenever the application installs another version.
 */
export function inspectSwcBuilderPackages(
  workingDir: string
): SwcBuilderStatus {
  const cliPackageJson = findPackageJson('@swc/cli', workingDir);
  const corePackageJson = findPackageJson(
    '@swc/core',
    cliPackageJson ? dirname(cliPackageJson) : workingDir
  );
  if (!corePackageJson) {
    return { cli: cliPackageJson !== null, core: { state: 'missing' } };
  }
  const version = readVersion(corePackageJson);
  return {
    cli: cliPackageJson !== null,
    core: {
      state: isSupportedSwcCoreVersion(version) ? 'supported' : 'unsupported',
      version,
      path: dirname(corePackageJson),
    },
  };
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

export function devInstallCommand(
  manager: PackageManager,
  packages: readonly string[]
): string {
  const prefix = {
    npm: 'npm i -D',
    pnpm: 'pnpm add -D',
    yarn: 'yarn add -D',
    bun: 'bun add -d',
  }[manager];
  return `${prefix} ${packages.join(' ')}`;
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
    lines.push(
      `⚠ ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} ` +
        'not installed. The NestJS SWC builder needs @swc/cli and ' +
        `@swc/core ${SUPPORTED_SWC_CORE_LINE}.x as dev dependencies.`
    );
  }
  if (core.state === 'unsupported') {
    lines.push(
      `⚠ @swc/core ${core.version} is installed, but the Workflow SWC ` +
        `plugin only runs on @swc/core ${SUPPORTED_SWC_CORE_LINE}.x, so ` +
        '`nest build` fails with "failed to invoke plugin".',
      `  Resolved from: ${core.path}`
    );
    install.push(SWC_CORE_INSTALL_SPEC);
  }
  if (install.length === 0) return null;
  lines.push('  Fix it with:', `  ${devInstallCommand(manager, install)}`);
  return lines.join('\n');
}
