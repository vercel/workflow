import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: [
    '@node-rs/xxhash',
    // lodash.chunk is included here to test the workflow VM require() fix.
    // See: https://github.com/vercel/workflow/pull/830
    'lodash.chunk',
  ],
};

// export default nextConfig;
export default withWorkflow(nextConfig);
