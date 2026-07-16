import { rewriteCookbookUrlForVersion } from './cookbook-source';
import { hasPathPrefix } from './path-prefix';

/**
 * Rewrite an href authored against the raw unversioned URL spaces
 * (`/docs/...`, `/docs/cookbook/...`, `/worlds/...`) into a version's public
 * view (e.g. `/v5/docs/...`, `/v5/cookbook/...`, `/v5/worlds/...`) so
 * navigation from a versioned page doesn't escape to the current-version
 * route. Non-string and external hrefs pass through untouched.
 */
export function rewriteHrefForVersion<T>(href: T, versionPrefix: string): T {
  if (typeof href !== 'string' || !versionPrefix) {
    return href;
  }

  let rewritten = rewriteCookbookUrlForVersion(href, versionPrefix);
  if (
    hasPathPrefix(rewritten, '/docs') ||
    hasPathPrefix(rewritten, '/worlds')
  ) {
    rewritten = `${versionPrefix}${rewritten}`;
  }

  return rewritten as T;
}
