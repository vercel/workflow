export type DocsVersionId = 'v4' | 'v5';

export interface DocsVersion {
  id: DocsVersionId;
  label: string;
  subtitle: string;
  prefix: string;
  /**
   * True for a version that is no longer the current release line. Maintenance
   * docs are served under a route prefix and excluded from search indexing.
   */
  maintenance: boolean;
}

export const VERSIONS: DocsVersion[] = [
  {
    id: 'v5',
    label: 'v5 (Latest)',
    subtitle: 'Workflow 5.x',
    prefix: '',
    maintenance: false,
  },
  {
    id: 'v4',
    label: 'v4 (Maintenance)',
    subtitle: 'Workflow 4.x',
    prefix: '/v4',
    maintenance: true,
  },
];

export const LATEST_VERSION: DocsVersion = VERSIONS[0];
export const MAINTENANCE_VERSION: DocsVersion = VERSIONS[1];

/**
 * Route segment the maintenance version is served under (`v4`). The latest
 * version has no prefix, so this is the only version segment in the URL space.
 */
export const MAINTENANCE_SEGMENT = MAINTENANCE_VERSION.prefix.replace(
  /^\//,
  ''
);

/**
 * Derive the active docs version from a pathname. Matches `/v4/...` (or
 * `/<lang>/v4/...` once locale prefix is applied) against the maintenance
 * prefix; everything else is the latest version.
 */
export function getVersionFromPathname(pathname: string): DocsVersion {
  // The version segment sits either at the root (default locale hidden) or
  // right after a locale segment — both cases are covered by checking
  // positions 0 and 1.
  const segments = pathname.split('/').filter(Boolean);
  if (
    segments[0] === MAINTENANCE_SEGMENT ||
    segments[1] === MAINTENANCE_SEGMENT
  ) {
    return MAINTENANCE_VERSION;
  }
  return LATEST_VERSION;
}

/**
 * Build a URL for the same page under a different version. Preserves the
 * trailing path after `/docs/` and any locale prefix.
 *
 * `/docs/...`, `/cookbook/...`, and `/worlds/...` paths are version-specific.
 * All other routes are shared across versions and are returned unchanged.
 *
 * `usePathname()` can return either `/docs/...` (default locale hidden by
 * the i18n middleware) or `/<locale>/docs/...` (non-default locale shown).
 * We detect the locale segment by checking whether segment 0 is a
 * structural path token (`docs` or `v4`) rather than assuming position.
 */
export function buildVersionUrl(
  pathname: string,
  targetVersion: DocsVersion
): string {
  const segments = pathname.split('/').filter(Boolean);
  // Structural segments are path tokens that are never locale prefixes.
  const isStructural = (s: string | undefined) =>
    s === 'docs' ||
    s === MAINTENANCE_SEGMENT ||
    s === 'cookbook' ||
    s === 'worlds';

  // Versioned routes carry a structural token at the root or right after a
  // locale segment; everything else is shared and returned unchanged.
  if (!isStructural(segments[0]) && !isStructural(segments[1])) {
    return pathname;
  }

  const localeSegments =
    segments[0] && !isStructural(segments[0]) ? segments.slice(0, 1) : [];
  let rest = segments.slice(localeSegments.length);
  if (rest[0] === MAINTENANCE_SEGMENT) rest = rest.slice(1);
  const prefixSegments = targetVersion.prefix
    ? [targetVersion.prefix.replace(/^\//, '')]
    : [];
  const joined = [...localeSegments, ...prefixSegments, ...rest].join('/');
  return `/${joined}`.replace(/\/+$/, '') || '/';
}
