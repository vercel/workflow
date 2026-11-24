import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ERROR_SLUGS, WorkflowBuildError } from '@workflow/errors';
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
 * bug) apart from a step in a file discovery does not scan for steps.
 */
export interface DiscoveryFacts {
  /** The file each workflow manifest `steps` key was compiled from. */
  stepFilePaths: ReadonlyMap<string, string>;
  /**
   * The files discovery scanned for steps (`discoveredFiles`). Without it every unregistered step fails the
   * build, as it cannot be told apart.
   */
  discoveredFiles?: ReadonlySet<string>;
  /** Whether discovery descended into `node_modules`. */
  discoverWorkflowsInNodeModules: boolean;
}

/**
 * Why discovery did not scan the file a step is in for steps:
 *
 * - `node-modules-discovery-disabled`: the file is under `node_modules`, or
 *   in the SDK, while discovery does not descend into `node_modules`
 *   (`WORKFLOW_DISCOVER_NODE_MODULES=0` or `discoverWorkflowsInNodeModules:
 *   false`).
 * - `not-reached`: discovery follows imports into a package only when it
 *   depends on `workflow` or an `@workflow/*` package, so it does not scan a
 *   file it reaches only through a package that does not, wherever the file
 *   is installed. (It may still read the one file such an import resolves to,
 *   for serde classes only.)
 */
export type SkippedStepReason =
  | 'node-modules-discovery-disabled'
  | 'not-reached';

export interface SkippedUnregisteredStep extends UnregisteredStep {
  reason: SkippedStepReason;
}

const isWindows = process.platform === 'win32';

const normalizeForComparison = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/');
  return isWindows ? normalized.toLowerCase() : normalized;
};

function tryRealpath(filePath: string): string | undefined {
  try {
    return realpathSync(filePath);
  } catch {
    return undefined;
  }
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
 * Returns a check for whether discovery scanned a file for steps. Paths are compared as
 * given first, then by their real paths, so a file discovery reached through
 * a symlink still counts as read. The real paths are only computed when the
 * first comparison misses.
 */
function createDiscoveredFileCheck(discoveredFiles: ReadonlySet<string>) {
  const discovered = new Set(
    [...discoveredFiles].map((file) => normalizeForComparison(file))
  );
  let discoveredRealpaths: Set<string> | undefined;
  return (filePath: string) => {
    if (discovered.has(normalizeForComparison(filePath))) {
      return true;
    }
    discoveredRealpaths ??= new Set(
      [...discoveredFiles].flatMap((file) => {
        const real = tryRealpath(file);
        return real ? [normalizeForComparison(real)] : [];
      })
    );
    const real = tryRealpath(filePath);
    return (
      real !== undefined &&
      discoveredRealpaths.has(normalizeForComparison(real))
    );
  };
}

/**
 * Splits unregistered steps into the ones discovery missed, which fail the
 * build, and the ones in files discovery did not scan for steps on purpose, which only
 * warn. A step counts as missed when discovery scanned its file, when its file
 * is in the SDK while discovery descends into `node_modules` (discovery
 * follows imports into the SDK then), or when the facts to tell are not there.
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
  const wasRead = createDiscoveredFileCheck(discovery.discoveredFiles);
  for (const step of steps) {
    const filePath = discovery.stepFilePaths.get(step.file);
    if (filePath === undefined || wasRead(filePath)) {
      missed.push(step);
      continue;
    }
    if (!discovery.discoverWorkflowsInNodeModules) {
      if (isSdkFile(filePath) || isNodeModulesPath(filePath)) {
        skipped.push({ ...step, reason: 'node-modules-discovery-disabled' });
        continue;
      }
    } else if (isSdkFile(filePath)) {
      missed.push(step);
      continue;
    }
    skipped.push({ ...step, reason: 'not-reached' });
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
  'not-reached':
    'discovery did not scan this file for steps, as it only follows imports into packages that depend on workflow or an @workflow/* package',
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
