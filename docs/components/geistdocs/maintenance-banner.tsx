import Link from 'next/link';
import {
  buildVersionUrl,
  LATEST_VERSION,
  MAINTENANCE_VERSION,
} from '@/lib/geistdocs/versions';

interface MaintenanceBannerProps {
  pathname: string;
}

const ClockRewind = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="none"
    height="16"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.5"
    viewBox="0 0 16 16"
    width="16"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M8 4.5V8l2.5 1.5" />
    <path d="M1.5 6.5V2.75" />
    <path d="M1.5 6.5h3.75" />
    <path d="M2.6 5.2A6.5 6.5 0 1 1 8 14.5a6.5 6.5 0 0 1-5.9-3.8" />
  </svg>
);

/**
 * Shown on the maintenance-version docs routes (`/v4/...`) so readers who
 * landed there from an old link know they aren't on the current docs, with a
 * one-click path to the same page on the latest version.
 */
export const MaintenanceBanner = ({ pathname }: MaintenanceBannerProps) => {
  const latestHref = buildVersionUrl(pathname, LATEST_VERSION);
  return (
    <div className="border-b bg-amber-100 px-4 py-2 text-center text-sm">
      <div className="mx-auto flex max-w-[1448px] flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-2 text-amber-900">
          <ClockRewind className="size-4 shrink-0" />
          <span>
            Viewing Workflow {MAINTENANCE_VERSION.id.replace(/^v/, '')}.x
            documentation. This version only receives stability fixes.
          </span>
        </div>
        <Link
          className="font-medium text-amber-900 underline underline-offset-4 decoration-amber-900/40 transition-colors hover:decoration-amber-900"
          href={latestHref}
        >
          Go to Workflow {LATEST_VERSION.id.replace(/^v/, '')} (Latest)
        </Link>
      </div>
    </div>
  );
};
