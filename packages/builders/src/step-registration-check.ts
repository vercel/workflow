import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ERROR_SLUGS, WorkflowBuildError } from '@workflow/errors';
import type { Metafile } from 'esbuild';
import type { WorkflowManifest } from './apply-swc-transform.js';
import { isNodeModulesPath } from './fast-discovery.js';

/**
 * Escape hatch that downgrades the unregistered-step build failure to a
 * warning, for a case where the check is wrong (a step the deployment
 * registers by some means the steps manifest does not record).
 */
export const ALLOW_UNREGISTERED_STEPS_ENV = 'WORKFLOW_ALLOW_UNREGISTERED_STEPS';

const DOCS_URL = `https://workflow-sdk.dev/err/${ERROR_SLUGS.STEP_NOT_REGISTERED}`;

/** Maximum number of steps listed in the error message. */
const MAX_REPORTED = 10;

/** A step the workflow bundle can call that the steps bundle does not register. */
export interface UnregisteredStep {
  stepId: string;
  /** Manifest file key the workflow bundle recorded the step under. */
  file: string;
  functionName: string;
}

/**
 * Returns the steps the workflow bundle has a proxy for (so workflow code can
 * call them) that the steps bundle does not register, sorted by step ID.
 * Every call to one of them fails at runtime with "Step ... is not registered
 * in the current deployment", so the build should not ship it.
 *
 * Steps are compared by ID, not by file: the same step can be recorded under
 * different file keys in the two bundles (a package resolved through a
 * different export condition, for example) while still sharing an ID.
 */
export function findUnregisteredSteps({
  workflowsManifest,
  stepsManifest,
}: {
  workflowsManifest: WorkflowManifest;
  stepsManifest: WorkflowManifest;
}): UnregisteredStep[] {
  const registered = new Set<string>();
  for (const fileSteps of Object.values(stepsManifest.steps ?? {})) {
    for (const { stepId } of Object.values(fileSteps)) {
      registered.add(stepId);
    }
  }

  const missing = new Map<string, UnregisteredStep>();
  for (const [file, fileSteps] of Object.entries(
    workflowsManifest.steps ?? {}
  )) {
    for (const [functionName, { stepId }] of Object.entries(fileSteps)) {
      if (!registered.has(stepId) && !missing.has(stepId)) {
        missing.set(stepId, { stepId, file, functionName });
      }
    }
  }
  return [...missing.values()].sort((a, b) =>
    a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0
  );
}

/**
 * What discovery did in this build, which tells a step discovery missed (a
 * bug) apart from a step in a file discovery declined to scan on purpose.
 */
export interface DiscoveryFacts {
  /** The files each step ID in the workflow manifest was compiled from. */
  stepFilePaths: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The files discovery scanned for steps (`discoveredFiles`). Without it
   * every unregistered step fails the build, as it cannot be told apart.
   */
  discoveredFiles?: ReadonlySet<string>;
  /** Roots of the packages discovery declined to walk (`declinedPackageRoots`). */
  declinedPackageRoots?: ReadonlySet<string>;
  /**
   * The workflow bundle's import graph. A file reachable from its entry
   * without entering a declined package is one discovery should have
   * scanned; without the graph, a file counts as declined only when it is
   * inside a declined package.
   */
  workflowBundleGraph?: { metafile: Metafile; workingDir: string };
  /** The project directory. A declined root that contains it is ignored. */
  workingDir?: string;
  /** Whether discovery descended into `node_modules`. */
  discoverWorkflowsInNodeModules: boolean;
}

/**
 * Why discovery did not scan the file a step is in for steps, on purpose:
 *
 * - `node-modules-discovery-disabled`: the file is only reached through an
 *   import from application code into `node_modules`, which discovery does
 *   not follow while node_modules discovery is off
 *   (`WORKFLOW_DISCOVER_NODE_MODULES=0` or `discoverWorkflowsInNodeModules:
 *   false`).
 * - `declined-package`: the file is only reached through a package that does
 *   not depend on `workflow` or an `@workflow/*` package, which discovery
 *   does not walk, wherever it is installed.
 */
export type SkippedStepReason =
  | 'node-modules-discovery-disabled'
  | 'declined-package';

export interface SkippedUnregisteredStep extends UnregisteredStep {
  reason: SkippedStepReason;
}

const isWindows = process.platform === 'win32';

const normalizeForComparison = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindows ? normalized.toLowerCase() : normalized;
};

function tryRealpath(filePath: string): string | undefined {
  try {
    return realpathSync(filePath);
  } catch {
    return undefined;
  }
}

/** The path, and its real path when it differs, normalized for comparison. */
function comparablePaths(filePath: string): string[] {
  const paths = [normalizeForComparison(filePath)];
  const real = tryRealpath(filePath);
  if (real !== undefined) {
    const normalizedReal = normalizeForComparison(real);
    if (normalizedReal !== paths[0]) paths.push(normalizedReal);
  }
  return paths;
}

const isInside = (filePath: string, root: string) =>
  filePath === root || filePath.startsWith(`${root}/`);

/**
 * Whether `filePath` is the SDK file that defines `Run` and its steps.
 * Discovery seeds it whether or not node_modules discovery is on, so a step
 * in it that is not registered is always a discovery bug.
 */
function isSeededRuntimeFile(filePath: string): boolean {
  const normalized = normalizeForComparison(filePath);
  return (
    /\/runtime\/run\.[cm]?js$/.test(normalized) &&
    /(^|\/)(@workflow\/core|core)\//.test(normalized) &&
    isSdkFile(filePath)
  );
}

/**
 * Whether the nearest `package.json` above `filePath` is the SDK's. A nested
 * `package.json` without a name (such as `dist/package.json` setting only
 * `type`) would hide the SDK's; no SDK package ships one today.
 */
function isSdkFile(filePath: string): boolean {
  let currentDir = dirname(filePath);
  while (currentDir && currentDir !== dirname(currentDir)) {
    try {
      const { name } = JSON.parse(
        readFileSync(resolve(currentDir, 'package.json'), 'utf8')
      ) as { name?: unknown };
      return (
        typeof name === 'string' &&
        (name === 'workflow' || name.startsWith('@workflow/'))
      );
    } catch {
      currentDir = dirname(currentDir);
    }
  }
  return false;
}

/**
 * The files of the workflow bundle reachable from its entry without entering
 * a declined package, and, while node_modules discovery is off, without an
 * import from application code into node_modules. Discovery should have
 * scanned every one of them, so a step in one that it did not register is a
 * miss.
 */
/** Inputs nothing imports: the entry points of the bundle. */
function findRootInputs(metafile: Metafile): string[] {
  const imported = new Set<string>();
  for (const info of Object.values(metafile.inputs)) {
    for (const { path } of info.imports) imported.add(path);
  }
  return Object.keys(metafile.inputs).filter((input) => !imported.has(input));
}

function findNormallyReachableFiles({
  metafile,
  workingDir,
  isDeclined,
  discoverWorkflowsInNodeModules,
}: {
  metafile: Metafile;
  workingDir: string;
  isDeclined: (filePath: string) => boolean;
  discoverWorkflowsInNodeModules: boolean;
}): Set<string> {
  // esbuild names synthetic inputs `<runtime>`, `<stdin>`.
  const toPath = (input: string) =>
    input.startsWith('<') && input.endsWith('>')
      ? undefined
      : normalizeForComparison(resolve(workingDir, input));
  // Mirrors the imports discovery declines to follow.
  const isFollowed = (from: string | undefined, to: string | undefined) =>
    to === undefined ||
    (!isDeclined(to) &&
      (discoverWorkflowsInNodeModules ||
        from === undefined ||
        isNodeModulesPath(from) ||
        !isNodeModulesPath(to)));

  const queue = findRootInputs(metafile).filter((input) =>
    isFollowed(undefined, toPath(input))
  );
  const seen = new Set(queue);
  const reachable = new Set<string>();
  while (queue.length > 0) {
    const input = queue.shift() as string;
    const from = toPath(input);
    if (from !== undefined) reachable.add(from);
    for (const { path: next } of metafile.inputs[input]?.imports ?? []) {
      if (seen.has(next) || !metafile.inputs[next]) continue;
      if (!isFollowed(from, toPath(next))) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return reachable;
}

/**
 * Splits unregistered steps into the ones discovery missed, which fail the
 * build, and the ones in files discovery declined to scan on purpose, which
 * only warn.
 *
 * A step is declined only when every file it was compiled from is reached
 * solely through a package discovery declined (or, while node_modules
 * discovery is off, solely through an import from application code into
 * node_modules). It counts as missed when discovery scanned one of its files,
 * when one of them is reachable without such a package (an import discovery
 * could not read, for example), when it is in the SDK's seeded runtime file,
 * or when the facts to tell are not there.
 */
export function classifyUnregisteredSteps(
  steps: UnregisteredStep[],
  discovery: DiscoveryFacts | undefined
): { missed: UnregisteredStep[]; skipped: SkippedUnregisteredStep[] } {
  const missed: UnregisteredStep[] = [];
  const skipped: SkippedUnregisteredStep[] = [];
  if (!discovery?.discoveredFiles) {
    return { missed: steps, skipped };
  }

  const scanned = new Set<string>();
  for (const file of discovery.discoveredFiles) {
    for (const path of comparablePaths(file)) scanned.add(path);
  }
  const workingDirPaths = discovery.workingDir
    ? comparablePaths(discovery.workingDir)
    : [];
  // A declined root that contains the project would make every file of it
  // count as declined, so it is ignored.
  const declinedRoots = [...(discovery.declinedPackageRoots ?? [])]
    .flatMap((root) => comparablePaths(root))
    .filter((root) => !workingDirPaths.some((dir) => isInside(dir, root)));
  const isDeclined = (path: string) =>
    declinedRoots.some((root) => isInside(path, root));

  let reachable: Set<string> | undefined;
  const isNormallyReachable = (paths: string[]) => {
    if (!discovery.workflowBundleGraph) return false;
    reachable ??= findNormallyReachableFiles({
      ...discovery.workflowBundleGraph,
      isDeclined,
      discoverWorkflowsInNodeModules: discovery.discoverWorkflowsInNodeModules,
    });
    const reachableFiles = reachable;
    return paths.some((path) => reachableFiles.has(path));
  };

  for (const step of steps) {
    const files = [...(discovery.stepFilePaths.get(step.stepId) ?? [])];
    const paths = files.map((file) => comparablePaths(file));
    const isMissed =
      files.length === 0 ||
      paths.some((filePaths) => filePaths.some((path) => scanned.has(path))) ||
      files.some((file) => isSeededRuntimeFile(file)) ||
      paths.some((filePaths) => isNormallyReachable(filePaths)) ||
      (!discovery.workflowBundleGraph &&
        !paths.every((filePaths) =>
          filePaths.some(
            (path) =>
              isDeclined(path) ||
              (!discovery.discoverWorkflowsInNodeModules &&
                isNodeModulesPath(path))
          )
        ));
    if (isMissed) {
      missed.push(step);
      continue;
    }
    const inDeclinedPackage = paths.some((filePaths) =>
      filePaths.some((path) => isDeclined(path))
    );
    skipped.push({
      ...step,
      reason:
        !discovery.discoverWorkflowsInNodeModules && !inDeclinedPackage
          ? 'node-modules-discovery-disabled'
          : 'declined-package',
    });
  }
  return { missed, skipped };
}

export function formatUnregisteredStepsMessage(
  steps: UnregisteredStep[]
): string {
  const count = steps.length;
  const lines = [
    `Workflow code can call ${count} ${count === 1 ? 'step' : 'steps'} that ${count === 1 ? 'is' : 'are'} not registered in the steps bundle. Every call would fail at runtime with "Step ... is not registered in the current deployment":`,
  ];
  for (const step of steps.slice(0, MAX_REPORTED)) {
    lines.push(`  - ${step.functionName} in ${step.file} (${step.stepId})`);
  }
  if (count > MAX_REPORTED) {
    lines.push(`  ...and ${count - MAX_REPORTED} more`);
  }
  return lines.join('\n');
}

const SKIPPED_REASON_TEXT: Record<SkippedStepReason, string> = {
  'node-modules-discovery-disabled': 'node_modules discovery is off',
  'declined-package':
    'it is only reached through a package that does not depend on workflow or an @workflow/* package, which discovery does not scan',
};

export function formatSkippedStepsMessage(
  steps: SkippedUnregisteredStep[]
): string {
  const count = steps.length;
  const lines = [
    `Workflow code can call ${count} ${count === 1 ? 'step' : 'steps'} that ${count === 1 ? 'is' : 'are'} not registered because discovery does not scan ${count === 1 ? 'its file' : 'their files'} for steps. A call to one fails at runtime with "Step ... is not registered in the current deployment":`,
  ];
  for (const step of steps.slice(0, MAX_REPORTED)) {
    lines.push(
      `  - ${step.functionName} in ${step.file} (${step.stepId}): ${SKIPPED_REASON_TEXT[step.reason]}`
    );
  }
  if (count > MAX_REPORTED) {
    lines.push(`  ...and ${count - MAX_REPORTED} more`);
  }
  return lines.join('\n');
}

function buildHint(): string {
  return [
    'The workflow bundle compiled these functions as steps, but their files were not discovered as step files, so the steps bundle left them out.',
    'Check that "use step" is the first statement of each function body. If it is, this is a Workflow SDK bug: please report it at https://github.com/vercel/workflow/issues.',
    `Set ${ALLOW_UNREGISTERED_STEPS_ENV}=1 to downgrade this to a warning (the calls will still fail at runtime). See ${DOCS_URL}`,
  ].join(' ');
}

function buildSkippedHint(): string {
  return [
    'Discovery follows imports into a package only when it depends on workflow or an @workflow/* package, and does not follow imports from your code into node_modules while node_modules discovery is off (WORKFLOW_DISCOVER_NODE_MODULES, or the discoverWorkflowsInNodeModules option).',
    'Nothing breaks unless workflow code calls one of these steps. If it does, turn node_modules discovery back on, or add the dependency to the package that contains the step and to each package that imports it on the way.',
    `See ${DOCS_URL}`,
  ].join(' ');
}

/**
 * Fails the build when the workflow bundle can call a step that the steps
 * bundle does not register.
 *
 * The workflow bundle compiles every step in a file it imports, called or
 * not, while discovery does not scan some files for steps on purpose. A step in such a
 * file only produces a warning, as failing on it would fail builds where
 * nothing calls the step. See `classifyUnregisteredSteps`. Without
 * `discovery`, every unregistered step fails the build.
 *
 * @param warn - Sink for the warnings: skipped steps, and every unregistered
 * step when the escape hatch is set.
 */
export function assertWorkflowStepsAreRegistered({
  workflowsManifest,
  stepsManifest,
  discovery,
  warn = (message: string) => console.warn(message),
}: {
  workflowsManifest: WorkflowManifest;
  stepsManifest: WorkflowManifest;
  discovery?: DiscoveryFacts;
  warn?: (message: string) => void;
}): UnregisteredStep[] {
  const unregistered = findUnregisteredSteps({
    workflowsManifest,
    stepsManifest,
  });
  if (unregistered.length === 0) return unregistered;

  const { missed, skipped } = classifyUnregisteredSteps(
    unregistered,
    discovery
  );
  if (skipped.length > 0) {
    warn(`${formatSkippedStepsMessage(skipped)}\n${buildSkippedHint()}`);
  }
  if (missed.length === 0) return unregistered;

  const message = formatUnregisteredStepsMessage(missed);
  const hint = buildHint();
  if (process.env[ALLOW_UNREGISTERED_STEPS_ENV] === '1') {
    warn(`${message}\n${hint}`);
    return unregistered;
  }
  throw new WorkflowBuildError(message, { hint });
}
