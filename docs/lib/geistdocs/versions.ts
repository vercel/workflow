export type DocsVersionId = 'v4' | 'v5';

export interface DocsVersion {
  id: DocsVersionId;
  label: string;
  subtitle: string;
  prefix: string;
  preRelease: boolean;
}

export const VERSIONS: DocsVersion[] = [
  {
    id: 'v5',
    label: 'v5 (Pre-release)',
    subtitle: 'Workflow 5.x',
    prefix: '/v5',
    preRelease: true,
  },
  {
    id: 'v4',
    label: 'v4 (Latest)',
    subtitle: 'Workflow 4.x',
    prefix: '',
    preRelease: false,
  },
];

export const LATEST_VERSION = VERSIONS.find((v) => !v.preRelease)!;
export const PRE_RELEASE_VERSION = VERSIONS.find((v) => v.preRelease)!;

/**
 * Derive the active docs version from a pathname. Matches `/v5/...` (or
 * `/<lang>/v5/...` once locale prefix is applied) against the pre-release
 * prefix; everything else is v4.
 */
export function getVersionFromPathname(pathname: string): DocsVersion {
  // The v5 segment sits either at the root (default locale hidden) or right
  // after a locale segment — both cases are covered by checking positions
  // 0 and 1.
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] === 'v5' || segments[1] === 'v5') {
    return PRE_RELEASE_VERSION;
  }
  return LATEST_VERSION;
}

/**
 * Build a URL for the same page under a different version. Preserves the
 * trailing path after `/docs/` and any locale prefix.
 *
 * Only `/docs/...` paths are version-specific. All other routes (e.g.
 * `/cookbook`, `/worlds`) are shared across versions and are returned
 * unchanged — there is no `/v5/cookbook` to navigate to.
 *
 * `usePathname()` can return either `/docs/...` (default locale hidden by
 * the i18n middleware) or `/<locale>/docs/...` (non-default locale shown).
 * We detect the locale segment by checking whether segment 0 is a
 * structural path token (`docs` or `v5`) rather than assuming position.
 */
export function buildVersionUrl(
  pathname: string,
  targetVersion: DocsVersion
): string {
  // Worlds and other shared routes have no versioned equivalent — unchanged.
  if (!pathname.includes('/docs') && !pathname.includes('/cookbook')) {
    return pathname;
  }

  const segments = pathname.split('/').filter(Boolean);
  // Structural segments are path tokens that are never locale prefixes.
  const isStructural = (s: string | undefined) =>
    s === 'docs' || s === 'v5' || s === 'cookbook';
  const localeSegments =
    segments[0] && !isStructural(segments[0]) ? segments.slice(0, 1) : [];
  let rest = segments.slice(localeSegments.length);
  if (rest[0] === 'v5') rest = rest.slice(1);
  const prefixSegments = targetVersion.prefix
    ? [targetVersion.prefix.replace(/^\//, '')]
    : [];
  const joined = [...localeSegments, ...prefixSegments, ...rest].join('/');
  return `/${joined}`.replace(/\/+$/, '') || '/';
}
