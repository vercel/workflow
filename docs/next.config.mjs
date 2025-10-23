import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    return [
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
            value: '(.*)text/markdown(.*)',
          },
        ],
      },
      {
        source: '/docs/:path*.(mdx|md)',
        destination: '/llms.mdx/:path*',
      },
    ];
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
