import { generateNotFoundMarkdown } from '@vercel/agent-readability';
import {
  getDocsTreeWithoutCookbook,
  rewriteCookbookUrlsInText,
} from '@/lib/geistdocs/cookbook-source';
import { i18n } from '@/lib/geistdocs/i18n';
import { getLLMText, source } from '@/lib/geistdocs/source';

export const revalidate = false;

const MARKDOWN_HEADERS = { 'Content-Type': 'text/markdown; charset=utf-8' };

export async function GET(
  _req: Request,
  { params }: RouteContext<'/[lang]/llms.mdx/[[...slug]]'>
) {
  const { slug, lang } = await params;
  const page = source.getPage(slug, lang);

  if (!page) {
    // Status 200 (not 404): agents commonly discard 404 response bodies.
    const requestedPath = slug?.length ? `/${slug.join('/')}` : '/';
    return new Response(generateNotFoundMarkdown(requestedPath), {
      headers: MARKDOWN_HEADERS,
    });
  }

  const sitemapPath =
    lang === i18n.defaultLanguage ? '/sitemap.md' : `/${lang}/sitemap.md`;

  const text = await getLLMText(page, getDocsTreeWithoutCookbook(lang, 'v4'));

  return new Response(
    rewriteCookbookUrlsInText(text) +
      `\n\n## Sitemap
[Overview of all docs pages](${sitemapPath})\n`,
    {
      headers: {
        'Content-Type': 'text/markdown',
      },
    }
  );
}

export const generateStaticParams = async ({
  params,
}: RouteContext<'/[lang]/llms.mdx/[[...slug]]'>) => {
  const { lang } = await params;

  // Exclude internal/preview-only pages from LLM scraping
  return source
    .generateParams(lang)
    .filter((p) => !p.slug?.includes('internal'));
};
