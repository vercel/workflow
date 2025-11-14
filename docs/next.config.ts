import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const withMDX = createMDX();

const config: NextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/sitemap.xml',
          destination: 'https://crawled-sitemap.vercel.sh/useworkflow.dev-.xml',
        },
        {
          source: '/docs/:path*',
          destination: '/llms.mdx/:path*',
          has: [
            {
              type: 'header',
              key: 'Accept',
              // Have text/markdown or text/plain but before any text/html
              // Note, that Claude Code currently requests text/plain
              value:
                '(?=.*(?:text/plain|text/markdown))(?!.*text/html.*(?:text/plain|text/markdown)).*',
            },
          ],
        },
      ],
      afterFiles: [
        {
          source: '/docs/:path*.(mdx|md)',
          destination: '/llms.mdx/:path*',
        },
      ],
    };
  },
  redirects: () => {
    return [
      {
        source: '/docs',
        destination: '/docs/getting-started',
        permanent: true,
      },
      {
        source: '/err/:slug',
        destination: '/docs/errors/:slug',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
