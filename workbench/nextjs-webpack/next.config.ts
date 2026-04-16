import type { NextConfig } from 'next';
import path from 'node:path';
import { withWorkflow } from 'workflow/next';

const tracingRoot = path.resolve(process.cwd(), '../..');
const generatedWorkflowsRoot = path.resolve(
  process.cwd(),
  '.generated/workflows'
);
const useGeneratedWorkflows = process.env.NODE_ENV === 'production';

const nextConfig: NextConfig = {
  /* config options here */
  outputFileTracingRoot: tracingRoot,
  // for easier debugging
  experimental: {
    serverMinification: false,
  },
  serverExternalPackages: ['@node-rs/xxhash'],
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
export default withWorkflow(nextConfig, { workflows: { lazyDiscovery: true } });
