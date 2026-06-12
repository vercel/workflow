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
        source: '/v5/docs',
        destination: '/v5/docs/getting-started',
        permanent: false,
      },
      {
        source: '/docs/cookbook',
        destination: '/patterns',
        permanent: true,
      },
      {
        source: '/docs/cookbook/:path*',
        destination: '/patterns',
        permanent: true,
      },
      {
        source: '/cookbooks',
        destination: '/patterns',
        permanent: true,
      },
      {
        source: '/cookbooks/:path*',
        destination: '/patterns',
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
      // Foundations "Common Patterns" page was retired — now part of /patterns
      {
        source: '/docs/foundations/common-patterns',
        destination: '/patterns',
        permanent: true,
      },
      {
        source: '/docs/foundations/control-flow-patterns',
        destination: '/patterns',
        permanent: true,
      },
      // /registry → /patterns (renamed)
      { source: '/registry', destination: '/patterns', permanent: true },
      {
        source: '/registry/:id',
        destination: '/patterns/:id',
        permanent: true,
      },
      // Renamed patterns
      {
        source: '/patterns/distributed-abort-controller',
        destination: '/patterns/kill-switch',
        permanent: true,
      },
      {
        source: '/r/distributed-abort-controller',
        destination: '/r/kill-switch',
        permanent: true,
      },
      {
        source: '/patterns/rate-limiting',
        destination: '/patterns/handling-rate-limits',
        permanent: true,
      },
      {
        source: '/r/rate-limiting',
        destination: '/r/handling-rate-limits',
        permanent: true,
      },
      // Cookbook → Patterns redirects (cookbook pages merged into patterns)
      { source: '/cookbook', destination: '/patterns', permanent: true },
      {
        source: '/cookbook/agent-patterns/agent-cancellation',
        destination: '/patterns/agent-cancellation',
        permanent: true,
      },
      {
        source: '/cookbook/agent-patterns/stop-workflow',
        destination: '/patterns/agent-cancellation',
        permanent: true,
      },
      {
        source: '/cookbook/agent-patterns/agent-stop-signal',
        destination: '/patterns/agent-cancellation',
        permanent: true,
      },
      {
        source: '/cookbook/agent-patterns/durable-agent',
        destination: '/patterns/durable-agent',
        permanent: true,
      },
      {
        source: '/cookbook/agent-patterns/human-in-the-loop',
        destination: '/patterns/human-in-the-loop',
        permanent: true,
      },
      {
        source: '/cookbook/integrations/ai-sdk',
        destination: '/patterns/ai-sdk',
        permanent: true,
      },
      {
        source: '/cookbook/integrations/chat-sdk',
        destination: '/patterns/chat-sdk',
        permanent: true,
      },
      {
        source: '/cookbook/integrations/sandbox',
        destination: '/patterns/sandbox',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/batching',
        destination: '/patterns/batching',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/idempotency',
        destination: '/patterns/idempotency',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/rate-limiting',
        destination: '/patterns/handling-rate-limits',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/saga',
        destination: '/patterns/saga',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/scheduling',
        destination: '/patterns/scheduling',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/sequential-and-parallel',
        destination: '/patterns/sequential-and-parallel',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/timeouts',
        destination: '/patterns/timeouts',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/webhooks',
        destination: '/patterns/webhooks',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/workflow-composition',
        destination: '/patterns/workflow-composition',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/child-workflows',
        destination: '/patterns/child-workflows',
        permanent: true,
      },
      {
        source: '/cookbook/common-patterns/distributed-abort-controller',
        destination: '/patterns/kill-switch',
        permanent: true,
      },
      {
        source: '/cookbook/advanced/child-workflows',
        destination: '/patterns/child-workflows',
        permanent: true,
      },
      {
        source: '/cookbook/advanced/distributed-abort-controller',
        destination: '/patterns/kill-switch',
        permanent: true,
      },
      // v5 cookbook pages merged into patterns (only advanced/serializable-steps
      // and advanced/publishing-libraries remain as docs)
      { source: '/v5/cookbook', destination: '/patterns', permanent: true },
      {
        source: '/v5/cookbook/agent-patterns/:id',
        destination: '/patterns/:id',
        permanent: true,
      },
      {
        source: '/v5/cookbook/common-patterns/:id',
        destination: '/patterns/:id',
        permanent: true,
      },
      {
        source: '/v5/cookbook/integrations/:id',
        destination: '/patterns/:id',
        permanent: true,
      },
      {
        source: '/v5/cookbook/advanced/child-workflows',
        destination: '/patterns/child-workflows',
        permanent: true,
      },
      {
        source: '/v5/cookbook/advanced/upgrading-workflows',
        destination: '/patterns/upgrading-workflows',
        permanent: true,
      },
      {
        source: '/python',
        destination: '/docs/getting-started/python',
        permanent: true,
      },
      // API reference restructure: getWorld and the World SDK moved from the
      // workflow-api section to workflow-runtime, and the observability
      // utilities page became its own workflow-observability section —
      // matching the `workflow/runtime` and `workflow/observability` import
      // paths these APIs are actually exported from. The observability rules
      // must come before the world/:path* catch-alls (first match wins).
      {
        source: '/docs/api-reference/workflow-api/world/observability',
        destination: '/docs/api-reference/workflow-observability',
        permanent: true,
      },
      {
        source: '/v5/docs/api-reference/workflow-api/world/observability',
        destination: '/v5/docs/api-reference/workflow-observability',
        permanent: true,
      },
      {
        source: '/docs/api-reference/workflow-api/get-world',
        destination: '/docs/api-reference/workflow-runtime/get-world',
        permanent: true,
      },
      {
        source: '/v5/docs/api-reference/workflow-api/get-world',
        destination: '/v5/docs/api-reference/workflow-runtime/get-world',
        permanent: true,
      },
      {
        source: '/docs/api-reference/workflow-api/world',
        destination: '/docs/api-reference/workflow-runtime/world',
        permanent: true,
      },
      {
        source: '/v5/docs/api-reference/workflow-api/world',
        destination: '/v5/docs/api-reference/workflow-runtime/world',
        permanent: true,
      },
      {
        source: '/docs/api-reference/workflow-api/world/:path*',
        destination: '/docs/api-reference/workflow-runtime/world/:path*',
        permanent: true,
      },
      {
        source: '/v5/docs/api-reference/workflow-api/world/:path*',
        destination: '/v5/docs/api-reference/workflow-runtime/world/:path*',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
