import { createProxy } from '@vercel/geistdocs/proxy';
import { config as geistdocsConfig } from '@/lib/geistdocs/config';
import { trackMdRequest } from '@/lib/md-tracking';

const proxy = createProxy({
  config: geistdocsConfig,
  trackMarkdownRequest: trackMdRequest,
  markdownRoutes: [
    { from: '/docs/*path', to: '/[lang]/llms.mdx/docs/*path' },
    { from: '/cookbook/*path', to: '/[lang]/llms.mdx/cookbook/*path' },
    { from: '/v5/docs/*path', to: '/[lang]/llms.mdx/v5/docs/*path' },
    {
      from: '/v5/cookbook/*path',
      to: '/[lang]/llms.mdx/v5/cookbook/*path',
    },
  ],
});

export const config = {
  matcher: [
    '/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|og(?:/|$)|.*\\.svg$|.*\\.zip$).*)',
  ],
};

export default proxy;
