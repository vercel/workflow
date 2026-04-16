import type { NextConfig } from 'next';
import path from 'node:path';
import { withWorkflow } from 'workflow/next';

const turbopackRoot = path.resolve(process.cwd(), '../..');
const generatedWorkflowsRoot = path.resolve(
  process.cwd(),
  '.generated/workflows'
);
const useGeneratedWorkflows = process.env.NODE_ENV === 'production';

const nextConfig: NextConfig = {
  /* config options here */
  outputFileTracingRoot: turbopackRoot,
  serverExternalPackages: ['@node-rs/xxhash'],
  turbopack: {
    // Keep Turbopack root aligned with repo root so @repo/* path aliases can
    // resolve files outside the app directory in both monorepo and staged temp layouts.
    root: turbopackRoot,
    ...(useGeneratedWorkflows
      ? {
          resolveAlias: {
            'workflow-workbench': generatedWorkflowsRoot,
          },
        }
      : {}),
  },
  webpack: (config) => {
    if (useGeneratedWorkflows) {
      config.resolve ??= {};
      config.resolve.alias ??= {};
      config.resolve.alias['workflow-workbench'] = generatedWorkflowsRoot;
    }

    return config;
  },
};

// export default nextConfig;
export default withWorkflow(nextConfig, {
  workflows: { lazyDiscovery: true },
});
