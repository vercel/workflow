import type { NextConfig } from 'next';
import path from 'node:path';
import { withWorkflow } from 'workflow/next';

const turbopackRoot = path.resolve(process.cwd(), '../..');

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ['@node-rs/xxhash'],
  turbopack: {
    // Keep Turbopack root aligned with repo root so @repo/* path aliases can
    // resolve files outside the app directory in both monorepo and staged temp layouts.
    root: turbopackRoot,
  },
};

// export default nextConfig;
export default withWorkflow(nextConfig, {
  workflows: { lazyDiscovery: true },
});
