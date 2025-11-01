export const validBuildTargets = [
  'standalone',
  'vercel-build-output-api',
  'next',
] as const;
export type BuildTarget = (typeof validBuildTargets)[number];

export type InspectCLIOptions = {
  json?: boolean;
  watch?: boolean;
  runId?: string;
  stepId?: string;
  hookId?: string;
  cursor?: string;
  sort?: 'asc' | 'desc';
  limit?: number;
  workflowName?: string;
  withData?: boolean;
  backend?: string;
  disableRelativeDates?: boolean;
};

export interface WorkflowConfig {
  watch?: boolean;
  dirs: string[];
  workingDir: string;
  buildTarget: BuildTarget;
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;

  // Optionally generate a client library for workflow execution. The preferred
  // method of using workflow is to use a loader within a framework (like
  // NextJS) that resolves client bindings on the fly.
  clientBundlePath?: string;

  externalPackages?: string[];

  workflowManifestPath?: string;
}

export function isValidBuildTarget(
  target: string | undefined
): target is BuildTarget {
  return target === 'standalone' || target === 'vercel-build-output-api';
}
