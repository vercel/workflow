import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from 'next/server';
import { isAIAgent } from '@/lib/ai-agent-detection';
import { i18n } from '@/lib/geistdocs/i18n';
import { trackMdRequest } from '@/lib/md-tracking';

const { rewrite: rewriteDocsLLM } = rewritePath(
  '/docs/*path',
  `/${i18n.defaultLanguage}/llms.mdx/*path`
);
const { rewrite: rewriteCookbookLLM } = rewritePath(
  '/cookbook/*path',
  `/${i18n.defaultLanguage}/llms.mdx/cookbook/*path`
);

function isDocsOrCookbookPath(pathname: string): boolean {
  return (
    pathname === '/docs' ||
    pathname.startsWith('/docs/') ||
    pathname === '/cookbook' ||
    pathname.startsWith('/cookbook/')
  );
}

function isDocsOrCookbookMarkdownPath(pathname: string): boolean {
  return (
    (pathname === '/docs.md' ||
      pathname === '/docs.mdx' ||
      pathname.startsWith('/docs/') ||
      pathname === '/cookbook.md' ||
      pathname === '/cookbook.mdx' ||
      pathname.startsWith('/cookbook/')) &&
    (pathname.endsWith('.md') || pathname.endsWith('.mdx'))
  );
}

function getMarkdownRewrite(pathname: string): string | null {
  if (pathname === '/docs') {
    return `/${i18n.defaultLanguage}/llms.mdx`;
  }

  if (pathname === '/cookbook') {
    return `/${i18n.defaultLanguage}/llms.mdx/cookbook`;
  }

  return rewriteDocsLLM(pathname) || rewriteCookbookLLM(pathname) || null;
}

const internationalizer = createI18nMiddleware(i18n);

const proxy = (request: NextRequest, context: NextFetchEvent) => {
  const pathname = request.nextUrl.pathname;

  // Track llms.txt requests
  if (pathname === '/llms.txt') {
    context.waitUntil(
      trackMdRequest({
        path: '/llms.txt',
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
        acceptHeader: request.headers.get('accept'),
      })
    );
  }

  // Handle .md/.mdx URL requests before i18n runs.
  if (isDocsOrCookbookMarkdownPath(pathname)) {
    const stripped = pathname.replace(/\.mdx?$/, '');
    const result = getMarkdownRewrite(stripped);

    if (result) {
      context.waitUntil(
        trackMdRequest({
          path: pathname,
          userAgent: request.headers.get('user-agent'),
          referer: request.headers.get('referer'),
          acceptHeader: request.headers.get('accept'),
        })
      );
      return NextResponse.rewrite(new URL(result, request.nextUrl));
    }
  }

  const markdownRewrite = getMarkdownRewrite(pathname);

  // AI agent detection — rewrite docs and cookbook pages to markdown for agents
  // so they always get structured content without needing .md URLs or Accept headers
  if (isDocsOrCookbookPath(pathname) && !pathname.includes('/llms.mdx/')) {
    const agentResult = isAIAgent(request);
    if (agentResult.detected && !isMarkdownPreferred(request)) {
      const result = markdownRewrite;

      if (result) {
        context.waitUntil(
          trackMdRequest({
            path: pathname,
            userAgent: request.headers.get('user-agent'),
            referer: request.headers.get('referer'),
            acceptHeader: request.headers.get('accept'),
            requestType: 'agent-rewrite',
            detectionMethod: agentResult.method,
          })
        );
        return NextResponse.rewrite(new URL(result, request.nextUrl));
      }
    }
  }

  // Handle Accept header content negotiation and track the request
  if (isMarkdownPreferred(request) && markdownRewrite) {
    context.waitUntil(
      trackMdRequest({
        path: pathname,
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
        acceptHeader: request.headers.get('accept'),
        requestType: 'header-negotiated',
      })
    );
    return NextResponse.rewrite(new URL(markdownRewrite, request.nextUrl));
  }

  // Fallback to i18n middleware
  return internationalizer(request, context);
};

export const config = {
  // Matcher ignoring `/_next/`, `/api/`, static assets, favicon, sitemap, robots, etc.
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|og|.*\\.tgz$|.*\\.svg$|.*\\.zip$).*)',
  ],
};

export default proxy;
