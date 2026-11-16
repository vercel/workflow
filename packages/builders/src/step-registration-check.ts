import { ERROR_SLUGS, WorkflowBuildError } from '@workflow/errors';
import type { WorkflowManifest } from './apply-swc-transform.js';

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

function buildHint(): string {
  return [
    'The workflow bundle compiled these functions as steps, but their files were not discovered as step files, so the steps bundle left them out.',
    'Check that "use step" is the first statement of each function body. If it is, this is a Workflow SDK bug: please report it at https://github.com/vercel/workflow/issues.',
    `Set ${ALLOW_UNREGISTERED_STEPS_ENV}=1 to downgrade this to a warning (the calls will still fail at runtime). See ${DOCS_URL}`,
  ].join(' ');
}

/**
 * Fails the build when the workflow bundle can call a step that the steps
 * bundle does not register.
 *
 * @param warn - Sink for the downgraded message when the escape hatch is set.
 */
export function assertWorkflowStepsAreRegistered({
  workflowsManifest,
  stepsManifest,
  warn = (message: string) => console.warn(message),
}: {
  workflowsManifest: WorkflowManifest;
  stepsManifest: WorkflowManifest;
  warn?: (message: string) => void;
}): UnregisteredStep[] {
  const unregistered = findUnregisteredSteps({
    workflowsManifest,
    stepsManifest,
  });
  if (unregistered.length === 0) return unregistered;

  const message = formatUnregisteredStepsMessage(unregistered);
  const hint = buildHint();
  if (process.env[ALLOW_UNREGISTERED_STEPS_ENV] === '1') {
    warn(`${message}\n${hint}`);
    return unregistered;
  }
  throw new WorkflowBuildError(message, { hint });
}
