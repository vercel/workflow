import { createDocsMarkdownRoute } from '@vercel/geistdocs/routes/llms';
import { config } from '@/lib/geistdocs/config';
import { allSources } from '@/lib/geistdocs/source';

export const { GET, generateStaticParams, revalidate } =
  createDocsMarkdownRoute({
    sources: allSources,
    // Keep the markdown output agent-discoverable: every page links out to the
    // full docs sitemap. See the sitemap rule in CLAUDE.md.
    transform: (markdown, { lang }) => {
      const sitemapPath =
        lang === (config.defaultLanguage ?? 'en')
          ? '/sitemap.md'
          : `/${lang}/sitemap.md`;

      return `${markdown}\n\n## Sitemap\n[Overview of all docs pages](${sitemapPath})\n`;
    },
  });
