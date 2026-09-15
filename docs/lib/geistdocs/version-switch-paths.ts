import {
  collectVersionPaths,
  type GeistdocsVersionPaths,
} from '@vercel/geistdocs/source';
import {
  cookbookSource,
  geistdocsSource,
  v4CookbookSource,
  v4GeistdocsSource,
  v4WorldsSourceBundle,
  worldsSourceBundle,
} from './source';

/**
 * Existing public paths per docs version, for the version switcher's 404
 * fallback: when the current page doesn't exist in the target version, the
 * switcher lands on the nearest existing ancestor (or `/docs`, which the app
 * redirects to getting-started) instead of a 404.
 *
 * The route sources already expose public URLs (the v4 ones prefixed with
 * `/v4`), so the v4 entry strips that prefix to get prefix-relative paths.
 */
export const getVersionSwitchPaths = (
  lang: string
): Record<string, GeistdocsVersionPaths> => ({
  v5: {
    fallbackPath: '/docs',
    paths: collectVersionPaths({
      lang,
      sources: [geistdocsSource, cookbookSource, worldsSourceBundle],
    }),
  },
  v4: {
    fallbackPath: '/docs',
    paths: collectVersionPaths({
      lang,
      routePrefix: '/v4',
      sources: [v4GeistdocsSource, v4CookbookSource, v4WorldsSourceBundle],
    }),
  },
});
