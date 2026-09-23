/**
 * Version-skew guard for the Vitest test setup.
 *
 * `@workflow/vitest` builds and runs your workflows against the copy of
 * `@workflow/core` it was installed with, not the one your app imports. When
 * the two copies disagree the failures are indirect (a run that never starts,
 * a world that is set on the wrong module instance, a serialization format the
 * other side does not understand), so check the versions up front and say what
 * to install instead.
 *
 * The common way to get here: Workflow 5 is published under the `beta` npm
 * tag, so `npm i -D @workflow/vitest` installs the 4.x line next to a v5 app.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Environment variable that turns the check off entirely. */
export const VERSION_CHECK_ENV_VAR = 'WORKFLOW_VITEST_VERSION_CHECK';

/** A Workflow package as some directory resolves it. */
export interface ResolvedPackage {
  name: string;
  version: string;
  /** Directory containing the package's `package.json`. */
  dir: string;
}

/** The packages the skew check compares. */
export interface WorkflowVersions {
  /** `@workflow/core` as `@workflow/vitest` resolves it. */
  harnessCore?: ResolvedPackage;
  /** `@workflow/core` as the project under test resolves it. */
  appCore?: ResolvedPackage;
  /** `@workflow/vitest` itself. */
  vitest?: ResolvedPackage;
  /** The `workflow` package the project depends on, when it has one. */
  appSdk?: ResolvedPackage;
}

export interface VersionSkewReport {
  /** `error` fails the test run; `warning` is logged and testing continues. */
  severity: 'error' | 'warning';
  message: string;
}

function readPackageJson(
  packageJsonPath: string
): { name?: string; version?: string } | undefined {
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Walk up from a resolved module file to the `package.json` of the package
 * that owns it. Package `exports` maps routinely omit `./package.json`, so
 * resolving the subpath directly is not reliable.
 */
function readOwningPackage(
  moduleFile: string,
  expectedName: string
): ResolvedPackage | undefined {
  let dir = dirname(moduleFile);
  const { root } = parse(dir);

  while (true) {
    const pkg = readPackageJson(join(dir, 'package.json'));
    if (pkg?.name === expectedName && pkg.version) {
      return { name: pkg.name, version: pkg.version, dir };
    }
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve a package as `fromDir` would resolve it, without importing it.
 * Returns `undefined` when the package is not installed there.
 */
export function resolvePackageFrom(
  name: string,
  fromDir: string
): ResolvedPackage | undefined {
  let entry: string;
  try {
    entry = createRequire(join(fromDir, 'noop.js')).resolve(name);
  } catch {
    return undefined;
  }
  return readOwningPackage(entry, name);
}

/**
 * Collect the versions the skew check compares.
 *
 * @param cwd - Root of the project under test.
 */
export function collectWorkflowVersions(cwd: string): WorkflowVersions {
  const here = dirname(fileURLToPath(import.meta.url));
  const vitest = readOwningPackage(join(here, 'index.js'), '@workflow/vitest');
  const harnessCore = resolvePackageFrom('@workflow/core', here);

  // Under pnpm's strict layout `@workflow/core` is not reachable from an app
  // that only depends on `workflow`, so go through `workflow` first and fall
  // back to a direct resolution for hoisted installs (and apps that depend on
  // `@workflow/core` on purpose).
  const appSdk = resolvePackageFrom('workflow', cwd);
  const appCore =
    (appSdk ? resolvePackageFrom('@workflow/core', appSdk.dir) : undefined) ??
    resolvePackageFrom('@workflow/core', cwd);

  return { harnessCore, appCore, vitest, appSdk };
}

function majorOf(version: string): number | undefined {
  const match = /^(\d+)(?:\.|$)/.exec(version);
  return match ? Number(match[1]) : undefined;
}

function describePackage(
  label: string,
  core: ResolvedPackage,
  via: ResolvedPackage | undefined
): string {
  const suffix = via ? ` (via ${via.name} ${via.version})` : '';
  return `  ${label} @workflow/core ${core.version}${suffix}\n${' '.repeat(label.length + 3)}${core.dir}`;
}

function installHint(appCoreVersion: string): string {
  const major = majorOf(appCoreVersion);
  // Workflow 5 only exists on the `beta` tag; the 4.x line is `latest`.
  return major !== undefined && major >= 5
    ? 'npm i -D @workflow/vitest@beta'
    : 'npm i -D @workflow/vitest@latest';
}

/**
 * Compare the resolved versions and describe the problem, if there is one.
 *
 * Pure: takes what {@link collectWorkflowVersions} found and returns the
 * report, so the policy can be tested without a node_modules tree.
 */
export function describeVersionSkew(
  versions: WorkflowVersions
): VersionSkewReport | undefined {
  const { appCore, harnessCore, vitest, appSdk } = versions;

  // Nothing to compare: either side missing means the failure (if any) will
  // be a plain "cannot find module", which is already clear on its own.
  if (!appCore || !harnessCore) return undefined;
  // The same install, or two copies that agree. Two copies of one version are
  // not worth a warning: they run the same code.
  if (appCore.dir === harnessCore.dir) return undefined;
  if (appCore.version === harnessCore.version) return undefined;

  const appMajor = majorOf(appCore.version);
  const harnessMajor = majorOf(harnessCore.version);
  // An unparseable version is not evidence of incompatibility, so treat it the
  // way a matching major is treated: warn, and let the run continue.
  const incompatible =
    appMajor !== undefined &&
    harnessMajor !== undefined &&
    appMajor !== harnessMajor;

  const header = incompatible
    ? 'Incompatible Workflow SDK versions in the Vitest test setup.'
    : 'Workflow SDK version mismatch in the Vitest test setup.';

  const explanation = incompatible
    ? '@workflow/vitest builds and runs your workflows against its own copy of @workflow/core, so it has to be on the same major as the SDK your app imports.'
    : 'Your app and the test harness load two different copies of @workflow/core. That usually still runs, but pin them to the same version to avoid surprises.';

  return {
    severity: incompatible ? 'error' : 'warning',
    message: [
      header,
      '',
      describePackage('app       ', appCore, appSdk),
      describePackage('test setup', harnessCore, vitest),
      '',
      explanation,
      '',
      '@workflow/vitest follows the same npm dist-tags as the rest of the SDK: `beta` for the Workflow 5 pre-releases, `latest` for the 4.x line.',
      '',
      `  ${installHint(appCore.version)}`,
      '',
      `Set ${VERSION_CHECK_ENV_VAR}=off to skip this check.`,
    ].join('\n'),
  };
}

function isDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[VERSION_CHECK_ENV_VAR]?.trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false';
}

/**
 * Run the skew check for a project. Throws on an incompatible pair, warns on
 * a version mismatch within one major, and is a no-op otherwise.
 *
 * Called from `buildWorkflowTests()` (Vitest `globalSetup`) so the report is
 * produced once per run rather than once per worker.
 */
export function checkWorkflowVersionSkew({
  cwd,
  env = process.env,
  warn = (message: string) => console.warn(message),
  collect = collectWorkflowVersions,
}: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  /** Seam for tests: where the resolved versions come from. */
  collect?: (cwd: string) => WorkflowVersions;
}): VersionSkewReport | undefined {
  if (isDisabled(env)) return undefined;

  const report = describeVersionSkew(collect(cwd));
  if (!report) return undefined;

  if (report.severity === 'error') {
    throw new Error(report.message);
  }
  warn(report.message);
  return report;
}
