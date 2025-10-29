import type { BuildTarget, WorkflowConfig } from './types.js';

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
    workingDir: process.cwd(),
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
