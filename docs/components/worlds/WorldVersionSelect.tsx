import { GeistdocsVersionSelect } from '@vercel/geistdocs/versions';
import { config } from '@/lib/geistdocs/config';
import type { DocsVersionId } from '@/lib/geistdocs/versions';

interface WorldVersionSelectProps {
  current: DocsVersionId;
  className?: string;
}

/**
 * Version switcher for the world detail pages. World docs are versioned like
 * the docs trees (/worlds/* for the current version, /v5/worlds/* for the
 * pre-release), but the worlds listing page has no natural home for the docs
 * sidebar switcher — so each world page renders its own.
 */
export function WorldVersionSelect({
  current,
  className,
}: WorldVersionSelectProps) {
  if (!config.versions) {
    return null;
  }

  return (
    <GeistdocsVersionSelect
      className={className ?? 'rounded-xl border bg-background-100'}
      current={current}
      versions={config.versions}
    />
  );
}
