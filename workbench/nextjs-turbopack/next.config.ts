import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ['@node-rs/xxhash'],

  // For debugging/testing: Makes Turbopack module IDs human-readable instead of hashed
  experimental: { turbopackModuleIds: 'named' },
};

// export default nextConfig;
export default withWorkflow(nextConfig);
