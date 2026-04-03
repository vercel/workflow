import { notFound } from 'next/navigation';
import { getLLMText, source } from '@/lib/geistdocs/source';
import { i18n } from '@/lib/geistdocs/i18n';

export const revalidate = false;

export async function GET(
  _req: Request,
  { params }: RouteContext<'/[lang]/llms.mdx/[[...slug]]'>
) {
  const { slug, lang } = await params;
  const page = source.getPage(slug, lang);

  if (!page) {
    notFound();
  }

  const sitemapPath =
    lang === i18n.defaultLanguage ? '/sitemap.md' : `/${lang}/sitemap.md`;

  return new Response(
    (await getLLMText(page)) +
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

  return source.generateParams(lang);
};
