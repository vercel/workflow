import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ['@node-rs/xxhash'],

  // Enable cross-origin isolation for SharedArrayBuffer (needed by Turso WASM)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
          },
        ],
      },
    ];
  },
};

// export default nextConfig;
export default withWorkflow(nextConfig, {
  browser: {
    include: ['app/workflows/browser/**/*.ts'],
  },
});
