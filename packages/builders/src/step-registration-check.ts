import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ERROR_SLUGS, WorkflowBuildError } from '@workflow/errors';
import type { WorkflowManifest } from './apply-swc-transform.js';
import {
  isNodeModulesPath,
  packageDeclaresWorkflow,
} from './fast-discovery.js';

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
 * Why discovery did not read a step's file on purpose, so the steps bundle
 * cannot register it:
 *
 * - `node-modules-discovery-disabled`: the file is under `node_modules` and
 *   discovery does not descend into `node_modules`
 *   (`WORKFLOW_DISCOVER_NODE_MODULES=0` or `discoverWorkflowsInNodeModules:
 *   false`).
 * - `no-workflow-dependency`: the file belongs to a package under
 *   `node_modules` that lists neither `workflow` nor an `@workflow/*`
 *   package among its dependencies, which discovery does not walk.
 */
export type SkippedStepReason =
  | 'node-modules-discovery-disabled'
  | 'no-workflow-dependency';

export interface SkippedUnregisteredStep extends UnregisteredStep {
  reason: SkippedStepReason;
}

/**
 * The nearest `package.json` above `filePath` that parses, read the way
 * discovery reads it (`findPackageInfo` in `fast-discovery.ts`), or
 * `undefined` when there is none.
 */
function readNearestPackageJson(
  filePath: string
): Parameters<typeof packageDeclaresWorkflow>[0] | undefined {
  let currentDir = dirname(filePath);
  while (currentDir && currentDir !== dirname(currentDir)) {
    try {
      return JSON.parse(
        readFileSync(resolve(currentDir, 'package.json'), 'utf8')
      );
    } catch {
      currentDir = dirname(currentDir);
    }
  }
  return undefined;
}

/**
 * Why discovery skipped `file` on purpose, or `undefined` when discovery was
 * supposed to read it (an application file, or a package it walks). Only a
 * step in a file discovery was supposed to read points at a discovery bug.
 */
export function getSkippedStepReason({
  file,
  workingDir,
  discoverWorkflowsInNodeModules,
}: {
  file: string;
  workingDir: string;
  discoverWorkflowsInNodeModules: boolean;
}): SkippedStepReason | undefined {
  const absolutePath = resolve(workingDir, file);
  if (!isNodeModulesPath(absolutePath)) {
    return undefined;
  }
  if (!discoverWorkflowsInNodeModules) {
    return 'node-modules-discovery-disabled';
  }
  const packageJson = readNearestPackageJson(absolutePath);
  if (packageJson && !packageDeclaresWorkflow(packageJson)) {
    return 'no-workflow-dependency';
  }
  return undefined;
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
  'no-workflow-dependency':
    'its package does not depend on workflow or an @workflow/* package',
};

export function formatSkippedStepsMessage(
  steps: SkippedUnregisteredStep[]
): string {
  const count = steps.length;
  const lines = [
    `Workflow code can call ${count} ${count === 1 ? 'step' : 'steps'} that ${count === 1 ? 'is' : 'are'} not registered because discovery does not read ${count === 1 ? 'its file' : 'their files'}. A call to one fails at runtime with "Step ... is not registered in the current deployment":`,
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
    'Discovery reads a package under node_modules only while node_modules discovery is on (WORKFLOW_DISCOVER_NODE_MODULES, or the discoverWorkflowsInNodeModules option), and only when the package depends on workflow or an @workflow/* package.',
    'Nothing breaks unless workflow code calls one of these steps. If it does, turn node_modules discovery back on, or add the dependency to that package.',
    `See ${DOCS_URL}`,
  ].join(' ');
}

/**
 * Fails the build when the workflow bundle can call a step that the steps
 * bundle does not register.
 *
 * A step whose file discovery skipped on purpose (see `SkippedStepReason`)
 * only produces a warning: the workflow bundle compiles every step in a file
 * it imports, called or not, so failing on those would fail builds where
 * nothing calls the step. They are told apart only when `workingDir` is
 * given; without it every unregistered step fails the build.
 *
 * @param warn - Sink for the warnings: skipped steps, and every unregistered
 * step when the escape hatch is set.
 */
export function assertWorkflowStepsAreRegistered({
  workflowsManifest,
  stepsManifest,
  workingDir,
  discoverWorkflowsInNodeModules = true,
  warn = (message: string) => console.warn(message),
}: {
  workflowsManifest: WorkflowManifest;
  stepsManifest: WorkflowManifest;
  /** Directory the manifest file keys are relative to. */
  workingDir?: string;
  /** Whether discovery descended into `node_modules` for this build. */
  discoverWorkflowsInNodeModules?: boolean;
  warn?: (message: string) => void;
}): UnregisteredStep[] {
  const unregistered = findUnregisteredSteps({
    workflowsManifest,
    stepsManifest,
  });
  if (unregistered.length === 0) return unregistered;

  const missed: UnregisteredStep[] = [];
  const skipped: SkippedUnregisteredStep[] = [];
  for (const step of unregistered) {
    const reason =
      workingDir === undefined
        ? undefined
        : getSkippedStepReason({
            file: step.file,
            workingDir,
            discoverWorkflowsInNodeModules,
          });
    if (reason) {
      skipped.push({ ...step, reason });
    } else {
      missed.push(step);
    }
  }

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
