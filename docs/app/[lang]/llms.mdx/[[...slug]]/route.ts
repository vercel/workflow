import { createDocsMarkdownRoute } from '@vercel/geistdocs/routes/llms';
import { allSources } from '@/lib/geistdocs/source';
import { LANGUAGE_QUERY_PARAM } from '@/lib/language';

const route = createDocsMarkdownRoute({ sources: allSources });

export const { generateStaticParams, revalidate } = route;

export function GET(
  request: Request,
  context: Parameters<typeof route.GET>[1]
) {
  const language = new URL(request.url).searchParams.get(LANGUAGE_QUERY_PARAM);
  return createDocsMarkdownRoute({
    sources: allSources.map((source) => ({
      ...source,
      getPageMarkdown: (page) => source.getPageMarkdown(page, language),
    })),
  }).GET(request, context);
}
