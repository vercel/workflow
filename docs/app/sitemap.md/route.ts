import { createSitemapMarkdownRoute } from '@vercel/geistdocs/routes/sitemap';
import type { NextRequest } from 'next/server';
import { config } from '@/lib/geistdocs/config';
import { allSources } from '@/lib/geistdocs/source';

const sitemap = createSitemapMarkdownRoute({
  config,
  sources: allSources.map((source) => ({ source })),
});

export const { revalidate, dynamic } = sitemap;

export const GET = (request: NextRequest) =>
  sitemap.GET(request, {
    params: Promise.resolve({ lang: config.defaultLanguage ?? 'en' }),
  });
