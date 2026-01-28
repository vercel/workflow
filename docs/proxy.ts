import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from 'next/server';
import { i18n } from '@/lib/geistdocs/i18n';

const { rewrite: rewriteLLM } = rewritePath(
  '/docs{/*path}',
  '/en/llms.mdx{/*path}'
);
const { rewrite: rewriteMdx } = rewritePath(
  '/docs{/*path}.mdx',
  '/en/llms.mdx{/*path}'
);
const { rewrite: rewriteMd } = rewritePath(
  '/docs{/*path}.md',
  '/en/llms.mdx{/*path}'
);

const internationalizer = createI18nMiddleware(i18n);

const proxy = (request: NextRequest, context: NextFetchEvent) => {
  const { pathname } = request.nextUrl;

  // Handle explicit .md/.mdx extension requests before i18n
  const mdxResult = rewriteMdx(pathname);
  if (mdxResult) {
    return NextResponse.rewrite(new URL(mdxResult, request.nextUrl));
  }
  const mdResult = rewriteMd(pathname);
  if (mdResult) {
    return NextResponse.rewrite(new URL(mdResult, request.nextUrl));
  }

  // Handle Accept header preference for markdown
  if (isMarkdownPreferred(request)) {
    const result = rewriteLLM(pathname);
    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl));
    }
  }

  // Fallback to i18n middleware
  return internationalizer(request, context);
};

export const config = {
  // Matcher ignoring `/_next/`, `/api/`, static assets, favicon, etc.
  matcher: ['/((?!sitemap.xml|api|_next/static|_next/image|favicon.ico).*)'],
};

export default proxy;
