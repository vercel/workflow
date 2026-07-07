'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { WorldDetailToc } from './WorldDetailToc';

type WorldDocsVersion = 'v4' | 'v5';

interface TocItem {
  id: string;
  title: ReactNode;
}

interface WorldDocsVersionPanelProps {
  id: string;
  v4Content: ReactNode;
  v4TocItems: TocItem[];
  v5Content: ReactNode;
  v5TocItems: TocItem[];
}

function readVersionFromUrl(): WorldDocsVersion {
  if (typeof window === 'undefined') return 'v5';
  return new URL(window.location.href).searchParams.get('version') === 'v4'
    ? 'v4'
    : 'v5';
}

export function WorldDocsVersionPanel({
  id,
  v4Content,
  v4TocItems,
  v5Content,
  v5TocItems,
}: WorldDocsVersionPanelProps) {
  const [activeVersion, setActiveVersion] = useState<WorldDocsVersion>('v5');

  useEffect(() => {
    setActiveVersion(readVersionFromUrl());

    const onPopState = () => setActiveVersion(readVersionFromUrl());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const setVersion = (version: WorldDocsVersion) => {
    setActiveVersion(version);
    const url = new URL(window.location.href);
    url.searchParams.set('version', version);
    window.history.pushState(null, '', url);
  };

  const content = activeVersion === 'v4' ? v4Content : v5Content;
  const tocItems = activeVersion === 'v4' ? v4TocItems : v5TocItems;

  return (
    <>
      <div className="mt-6 flex justify-end">
        <fieldset className="inline-flex rounded-md border bg-background-100 p-0.5">
          <legend className="sr-only">World docs version</legend>
          {(['v4', 'v5'] as const).map((version) => (
            <button
              key={version}
              type="button"
              aria-pressed={version === activeVersion}
              onClick={() => setVersion(version)}
              className={cn(
                'rounded-sm px-3 py-1.5 font-medium text-sm transition-colors',
                version === activeVersion
                  ? 'bg-background-200 text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {version}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-8 lg:gap-12">
        <main className="min-w-0">
          <div className="py-8 sm:py-12 prose prose-neutral dark:prose-invert max-w-none">
            {content}
          </div>
        </main>

        <aside className="hidden lg:block pt-8 sm:pt-12">
          <div className="sticky top-24">
            <WorldDetailToc key={id + activeVersion} items={tocItems} />
          </div>
        </aside>
      </div>
    </>
  );
}
