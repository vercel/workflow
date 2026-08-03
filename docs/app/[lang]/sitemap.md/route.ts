import { createSitemapMarkdownRoute } from '@vercel/geistdocs/routes/sitemap';
import { config } from '@/lib/geistdocs/config';
import { allSources } from '@/lib/geistdocs/source';

export const { GET, generateStaticParams, revalidate, dynamic } =
  createSitemapMarkdownRoute({
    config,
    sources: allSources.map((source) => ({ source })),
  });
