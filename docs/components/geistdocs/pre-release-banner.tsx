import Link from 'next/link';
import {
  buildVersionUrl,
  LATEST_VERSION,
  PRE_RELEASE_VERSION,
} from '@/lib/geistdocs/versions';

interface PreReleaseBannerProps {
  pathname: string;
}

const SparklesFilled = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M12 2.5c.33 0 .62.22.72.54l1.43 4.8 4.8 1.43a.75.75 0 0 1 0 1.44l-4.8 1.43-1.43 4.8a.75.75 0 0 1-1.44 0l-1.43-4.8-4.8-1.43a.75.75 0 0 1 0-1.44l4.8-1.43 1.43-4.8c.1-.32.39-.54.72-.54Zm7 11a.6.6 0 0 1 .57.4l.72 2.31 2.31.72a.6.6 0 0 1 0 1.14l-2.31.72-.72 2.31a.6.6 0 0 1-1.14 0l-.72-2.31-2.31-.72a.6.6 0 0 1 0-1.14l2.31-.72.72-2.31a.6.6 0 0 1 .57-.4Z" />
  </svg>
);

export const PreReleaseBanner = ({ pathname }: PreReleaseBannerProps) => {
  const latestHref = buildVersionUrl(pathname, LATEST_VERSION);
  return (
    <div className="border-b bg-blue-50 px-4 py-2 text-center text-sm dark:bg-blue-950/40">
      <div className="mx-auto flex max-w-[1448px] flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
          <SparklesFilled className="size-4 shrink-0" />
          <span>
            Viewing Workflow {PRE_RELEASE_VERSION.id.replace(/^v/, '')}{' '}
            (Pre-release) Documentation.
          </span>
        </div>
        <Link
          className="font-medium text-blue-600 underline underline-offset-4 decoration-blue-600/40 transition-colors hover:text-blue-800 hover:decoration-blue-800 dark:text-blue-400 dark:decoration-blue-400/40 dark:hover:text-blue-200 dark:hover:decoration-blue-200"
          href={latestHref}
        >
          Go to Workflow {LATEST_VERSION.id.replace(/^v/, '')} (Latest)
        </Link>
      </div>
    </div>
  );
};
