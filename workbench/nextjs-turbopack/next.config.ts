import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ['@node-rs/xxhash'],

  experimental: { turbopackModuleIds: 'named' },
};

// export default nextConfig;
export default withWorkflow(nextConfig);
