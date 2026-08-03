import path from 'node:path';
import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const turbopackRoot = path.resolve(process.cwd(), '../..');

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ['@node-rs/xxhash'],
  // Allow portless-style worktree-prefixed .localhost subdomains (e.g.
  // https://<branch>.turbopack.localhost) so HMR and dev-only endpoints
  // aren't blocked by Next's cross-origin protection in dev.
  allowedDevOrigins: ['turbopack.localhost', '*.turbopack.localhost'],
  turbopack: {
    // Keep Turbopack root aligned with repo root so @repo/* path aliases can
    // resolve files outside the app directory in both monorepo and staged temp layouts.
    root: turbopackRoot,
  },
};

export default withWorkflow(nextConfig);
