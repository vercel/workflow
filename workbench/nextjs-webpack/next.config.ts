import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  /* config options here */
  // for easier debugging
  experimental: {
    serverMinification: false,
  },
  serverExternalPackages: ['@node-rs/xxhash'],
};

// export default nextConfig;
export default withWorkflow(nextConfig);
