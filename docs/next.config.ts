import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const withMDX = createMDX();

const config: NextConfig = {
  experimental: {
    turbopackFileSystemCacheForDev: true,
  },

  typescript: {
    ignoreBuildErrors: true,
  },

  outputFileTracingIncludes: {
    '/og/\\[\\.\\.\\.slug\\]': ['./lib/og/assets/**/*'],
    '/worlds/\\[id\\]/opengraph-image': ['./lib/og/assets/**/*'],
  },

  async rewrites() {
    const markdownAcceptHeader =
      '(?=.*(?:text/plain|text/markdown))(?!.*text/html.*(?:text/plain|text/markdown)).*';

    return {
      beforeFiles: [
        {
          source: '/docs/:path*',
          destination: '/llms.mdx/:path*',
          has: [
            {
              type: 'header',
              key: 'Accept',
              value: markdownAcceptHeader,
            },
          ],
        },
        {
          source: '/cookbook',
          destination: '/llms.mdx/cookbook',
          has: [
            {
              type: 'header',
              key: 'Accept',
              value: markdownAcceptHeader,
            },
          ],
        },
        {
          source: '/cookbook/:path*',
          destination: '/llms.mdx/cookbook/:path*',
          has: [
            {
              type: 'header',
              key: 'Accept',
              value: markdownAcceptHeader,
            },
          ],
        },
      ],
    };
  },

  async redirects() {
    return [
      {
        source: '/docs',
        destination: '/docs/getting-started',
        permanent: true,
      },
      {
        source: '/docs/cookbook',
        destination: '/cookbook',
        permanent: true,
      },
      {
        source: '/docs/cookbook/:path*',
        destination: '/cookbook/:path*',
        permanent: true,
      },
      {
        source: '/cookbooks',
        destination: '/cookbook',
        permanent: true,
      },
      {
        source: '/cookbooks/:path*',
        destination: '/cookbook/:path*',
        permanent: true,
      },
      {
        source: '/err/:slug',
        destination: '/docs/errors/:slug',
        permanent: true,
      },
      // Redirect old world docs to new /worlds routes
      {
        source: '/docs/deploying/world/local-world',
        destination: '/worlds/local',
        permanent: true,
      },
      {
        source: '/docs/deploying/world/postgres-world',
        destination: '/worlds/postgres',
        permanent: true,
      },
      {
        source: '/docs/deploying/world/vercel-world',
        destination: '/worlds/vercel',
        permanent: true,
      },
      {
        source: '/docs/worlds',
        destination: '/worlds',
        permanent: true,
      },
      // Foundations "Common Patterns" page was retired in favor of dedicated
      // cookbook recipes. Path-level redirect lands visitors on the cookbook
      // overview where each pattern (Sequential & Parallel, Workflow
      // Composition, Timeouts, etc.) has its own page. Note: anchor fragments
      // from old links (#timeout-pattern, #direct-await-flattening, etc.) are
      // dropped on redirect — Next.js redirects() does not match anchors.
      {
        source: '/docs/foundations/common-patterns',
        destination: '/cookbook',
        permanent: true,
      },
      {
        source: '/docs/foundations/control-flow-patterns',
        destination: '/cookbook',
        permanent: true,
      },
      // Cookbook: child-workflows and distributed-abort-controller moved
      // from common-patterns (now "Reliability Patterns") to advanced
      {
        source: '/cookbook/common-patterns/child-workflows',
        destination: '/cookbook/advanced/child-workflows',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/distributed-abort-controller',
        destination: '/cookbook/advanced/distributed-abort-controller',
        permanent: true,
      },
      // Cookbook: stop-workflow → agent-stop-signal → agent-cancellation.
      // The page now covers both Hard Cancellation (run.cancel()) and Stop
      // Signal (hook + Promise.race) as named patterns, so the broader
      // "Agent Cancellation" title fits both. Both prior URLs land directly
      // on the current page (no redirect chains).
      {
        source: '/cookbook/agent-patterns/stop-workflow',
        destination: '/cookbook/agent-patterns/agent-cancellation',
        permanent: true,
      },
      {
        source: '/cookbook/agent-patterns/agent-stop-signal',
        destination: '/cookbook/agent-patterns/agent-cancellation',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
