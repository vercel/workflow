'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  buildVersionUrl,
  type DocsVersion,
  getVersionFromPathname,
  LATEST_VERSION,
  VERSIONS,
} from '@/lib/geistdocs/versions';

const STORAGE_KEY = 'workflow-docs-version';

function getStoredVersion(): DocsVersion {
  if (typeof window === 'undefined') return LATEST_VERSION;
  const stored = localStorage.getItem(STORAGE_KEY);
  return VERSIONS.find((v) => v.id === stored) ?? LATEST_VERSION;
}

function persistVersion(version: DocsVersion) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, version.id);
  }
}

interface VersionContextValue {
  activeVersion: DocsVersion;
  switchVersion: (target: DocsVersion) => Promise<void>;
}

const VersionContext = createContext<VersionContextValue | null>(null);

export const VersionProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const pathname = usePathname();
  const router = useRouter();

  // Both /docs and /cookbook routes carry version in the URL.
  const isVersionedPage =
    pathname.includes('/docs') || pathname.includes('/cookbook');
  const urlVersion = isVersionedPage ? getVersionFromPathname(pathname) : null;

  // Initialize from localStorage; docs pages override this via urlVersion.
  const [storedVersion, setStoredVersion] = useState<DocsVersion>(() =>
    getStoredVersion()
  );

  // On docs pages the URL is the source of truth — sync it to localStorage
  // so non-docs pages can pick it up after navigation.
  useEffect(() => {
    if (urlVersion && urlVersion.id !== storedVersion.id) {
      setStoredVersion(urlVersion);
      persistVersion(urlVersion);
    }
  }, [urlVersion?.id]);

  const activeVersion = urlVersion ?? storedVersion;

  const switchVersion = useCallback(
    async (target: DocsVersion) => {
      setStoredVersion(target);
      persistVersion(target);
      if (!isVersionedPage) {
        // On worlds and other unversioned pages just update the stored preference.
        return;
      }

      const targetUrl = buildVersionUrl(pathname, target);

      // Some pages exist in one version but not the other (e.g. v4-only
      // recipes, v5-only docs). Probe the target URL with a HEAD request
      // before navigating; if it 404s fall back to the versioned home for
      // that section rather than landing on a 404.
      try {
        const res = await fetch(targetUrl, { method: 'HEAD' });
        if (!res.ok) {
          const fallback = pathname.includes('/cookbook')
            ? `${target.prefix}/cookbook`
            : `${target.prefix}/docs/getting-started`;
          router.push(fallback);
          return;
        }
      } catch {
        const fallback = pathname.includes('/cookbook')
          ? `${target.prefix}/cookbook`
          : `${target.prefix}/docs/getting-started`;
        router.push(fallback);
        return;
      }

      router.push(targetUrl);
    },
    [isVersionedPage, pathname, router]
  );

  return (
    <VersionContext.Provider value={{ activeVersion, switchVersion }}>
      {children}
    </VersionContext.Provider>
  );
};

export function useVersion(): VersionContextValue {
  const ctx = useContext(VersionContext);
  if (!ctx) throw new Error('useVersion must be used inside VersionProvider');
  return ctx;
}
