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
  const segments = pathname.split('/').filter(Boolean);
  // segments[0] may be a locale (e.g. 'en'); the version prefix sits
  // immediately after the optional locale segment.
  if (segments[0] === 'v5' || segments[1] === 'v5') {
    return PRE_RELEASE_VERSION;
  }
  return LATEST_VERSION;
}

/**
 * Build a URL for the same page under a different version. Preserves the
 * trailing path after `/docs/` and any locale prefix.
 */
export function buildVersionUrl(
  pathname: string,
  targetVersion: DocsVersion
): string {
  const segments = pathname.split('/').filter(Boolean);
  const locale = segments[0];
  const rest =
    segments[1] === 'v5'
      ? segments.slice(2) // strip /<locale>/v5
      : segments.slice(1); // strip /<locale>
  const tail = rest.join('/');
  const prefix = targetVersion.prefix;
  return `/${locale}${prefix}/${tail}`.replace(/\/+$/, '');
}
