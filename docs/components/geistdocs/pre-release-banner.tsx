import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import {
  buildVersionUrl,
  LATEST_VERSION,
  PRE_RELEASE_VERSION,
} from '@/lib/geistdocs/versions';

interface PreReleaseBannerProps {
  pathname: string;
}

export const PreReleaseBanner = ({ pathname }: PreReleaseBannerProps) => {
  const latestHref = buildVersionUrl(pathname, LATEST_VERSION);
  return (
    <div className="border-b bg-blue-50 px-4 py-2 text-center text-sm dark:bg-blue-950/40">
      <div className="mx-auto flex max-w-[1448px] flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <Sparkles
          aria-hidden="true"
          className="size-4 shrink-0 text-blue-600 dark:text-blue-400"
        />
        <span className="text-blue-900 dark:text-blue-100">
          Viewing Workflow {PRE_RELEASE_VERSION.id.replace(/^v/, '')}{' '}
          (Pre-release) Documentation.
        </span>
        <Link
          className="rounded border border-blue-300 bg-background-100 px-2 py-0.5 font-medium text-blue-900 hover:bg-background-200 dark:border-blue-800 dark:text-blue-100"
          href={latestHref}
        >
          Go to Workflow {LATEST_VERSION.id.replace(/^v/, '')} (Latest)
        </Link>
      </div>
    </div>
  );
};
