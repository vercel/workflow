import type { MetadataRoute } from 'next';

import { currentSources } from '@/lib/geistdocs/source';

const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
const host =
  process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ?? 'localhost:3000';
const baseUrl = `${protocol}://${host}`;

export const revalidate = false;

export default function sitemap(): MetadataRoute.Sitemap {
  const url = (path: string): string => new URL(path, baseUrl).toString();

  const pages: MetadataRoute.Sitemap = [];

  for (const source of currentSources) {
    for (const page of source.source.getPages()) {
      // Exclude internal/preview-only pages from sitemap
      if (page.url.includes('/internal')) continue;
      pages.push({
        changeFrequency: 'weekly' as const,
        lastModified: undefined,
        priority: 0.5,
        url: url(page.url),
      });
    }
  }

  return [
    {
      changeFrequency: 'monthly',
      priority: 1,
      url: url('/'),
    },
    ...pages,
  ];
}
