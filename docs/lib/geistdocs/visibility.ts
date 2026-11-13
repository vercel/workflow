/**
 * Preview deployments and local development. Production (and a local
 * `next start`) is everything else.
 */
export const isPreview =
  process.env.VERCEL_ENV === 'preview' ||
  process.env.NODE_ENV === 'development';

/**
 * Pages with `internal: true` frontmatter (the `/docs/internal` tooling pages)
 * are preview-only: production answers 404 for them and drops them from the
 * sidebar. Geistdocs already keeps them out of search, llms.txt, chat and the
 * markdown sitemap, and marks them `noindex, nofollow`, on every deployment.
 */
export const canViewPage = (page: { data: unknown }): boolean =>
  isPreview || (page.data as { internal?: boolean }).internal !== true;
