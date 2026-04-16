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
      // Redirect old control-flow-patterns to common-patterns
      {
        source: '/docs/foundations/control-flow-patterns',
        destination: '/docs/foundations/common-patterns',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
