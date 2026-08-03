import {
  collectVersionPaths,
  type GeistdocsVersionPaths,
} from '@vercel/geistdocs/source';
import {
  cookbookSource,
  geistdocsSource,
  v5CookbookSource,
  v5GeistdocsSource,
  v5WorldsSourceBundle,
  worldsSourceBundle,
} from './source';

/**
 * Existing public paths per docs version, for the version switcher's 404
 * fallback: when the current page doesn't exist in the target version, the
 * switcher lands on the nearest existing ancestor (or `/docs`, which the app
 * redirects to getting-started) instead of a 404.
 *
 * The route sources already expose public URLs (the v5 ones prefixed with
 * `/v5`), so the v5 entry strips that prefix to get prefix-relative paths.
 */
export const getVersionSwitchPaths = (
  lang: string
): Record<string, GeistdocsVersionPaths> => ({
  v4: {
    fallbackPath: '/docs',
    paths: collectVersionPaths({
      lang,
      sources: [geistdocsSource, cookbookSource, worldsSourceBundle],
    }),
  },
  v5: {
    fallbackPath: '/docs',
    paths: collectVersionPaths({
      lang,
      routePrefix: '/v5',
      sources: [v5GeistdocsSource, v5CookbookSource, v5WorldsSourceBundle],
    }),
  },
});
