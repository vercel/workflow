import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from 'next/server';
import { i18n } from '@/lib/geistdocs/i18n';

const { rewrite: rewriteMd } = rewritePath(
  '/docs/*path.md',
  '/en/llms.mdx/*path'
);
const { rewrite: rewriteMdx } = rewritePath(
  '/docs/*path.mdx',
  '/en/llms.mdx/*path'
);
const { rewrite: rewriteLLM } = rewritePath(
  '/docs/*path',
  '/en/llms.mdx/*path'
);

const internationalizer = createI18nMiddleware(i18n);

const proxy = (request: NextRequest, context: NextFetchEvent) => {
  const { pathname } = request.nextUrl;

  // First, handle Markdown preference rewrites
  const rewrittenMd = rewriteMd(pathname);
  const rewrittenMdx = rewriteMdx(pathname);
  const rewrittenForLLM = isMarkdownPreferred(request) && rewriteLLM(pathname);

  const resultToRewrite = rewrittenMd || rewrittenMdx || rewrittenForLLM;
  if (resultToRewrite) {
    return NextResponse.rewrite(new URL(resultToRewrite, request.nextUrl));
  }

  // Fallback to i18n middleware
  return internationalizer(request, context);
};

export const config = {
  // Matcher ignoring `/_next/`, `/api/`, static assets, favicon, etc.
  matcher: ['/((?!sitemap.xml|api|_next/static|_next/image|favicon.ico).*)'],
};

export default proxy;
