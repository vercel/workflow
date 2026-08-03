import type { MetadataRoute } from 'next';

const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
const host =
  process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ?? 'localhost:3000';
const baseUrl = `${protocol}://${host}`;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/*/docs/internal/', '/docs/internal/'],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
