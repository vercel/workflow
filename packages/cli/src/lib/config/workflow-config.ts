import type { BuildTarget, WorkflowConfig } from './types.js';
import { resolve } from 'node:path';

function resolveObservabilityCwd(): string {
  const raw = process.env.WORKFLOW_OBSERVABILITY_CWD;
  if (!raw) {
    return process.cwd();
  }
  // Allow relative paths; resolve relative to the current process.cwd()
  // (i.e. where the CLI was invoked).
  return resolve(process.cwd(), raw);
}

export const getWorkflowConfig = (
  {
    buildTarget,
    workflowManifest,
  }: {
    buildTarget?: BuildTarget;
    workflowManifest?: string;
  } = {
    buildTarget: 'standalone',
  }
) => {
  const config: WorkflowConfig = {
    dirs: ['./workflows'],
    workingDir: resolveObservabilityCwd(),
    buildTarget: buildTarget as BuildTarget,
    stepsBundlePath: './.well-known/workflow/v1/step.js',
    workflowsBundlePath: './.well-known/workflow/v1/flow.js',
    webhookBundlePath: './.well-known/workflow/v1/webhook.js',
    workflowManifestPath: workflowManifest,

    // WIP: generate a client library to easily execute workflows/steps
    // clientBundlePath: './lib/generated/workflows.js',
  };
  return config;
};
