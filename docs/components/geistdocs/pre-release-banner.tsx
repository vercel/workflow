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
    height="16"
    viewBox="0 0 16 16"
    width="16"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M2.5 0.5V0H3.5V0.5C3.5 1.60457 4.39543 2.5 5.5 2.5H6V3V3.5H5.5C4.39543 3.5 3.5 4.39543 3.5 5.5V6H3H2.5V5.5C2.5 4.39543 1.60457 3.5 0.5 3.5H0V3V2.5H0.5C1.60457 2.5 2.5 1.60457 2.5 0.5Z" />
    <path d="M14.5 4.5V5H13.5V4.5C13.5 3.94772 13.0523 3.5 12.5 3.5H12V3V2.5H12.5C13.0523 2.5 13.5 2.05228 13.5 1.5V1H14H14.5V1.5C14.5 2.05228 14.9477 2.5 15.5 2.5H16V3V3.5H15.5C14.9477 3.5 14.5 3.94772 14.5 4.5Z" />
    <path d="M8.40706 4.92939L8.5 4H9.5L9.59294 4.92939C9.82973 7.29734 11.7027 9.17027 14.0706 9.40706L15 9.5V10.5L14.0706 10.5929C11.7027 10.8297 9.82973 12.7027 9.59294 15.0706L9.5 16H8.5L8.40706 15.0706C8.17027 12.7027 6.29734 10.8297 3.92939 10.5929L3 10.5V9.5L3.92939 9.40706C6.29734 9.17027 8.17027 7.29734 8.40706 4.92939Z" />
  </svg>
);

export const PreReleaseBanner = ({ pathname }: PreReleaseBannerProps) => {
  const latestHref = buildVersionUrl(pathname, LATEST_VERSION);
  return (
    <div className="border-b bg-blue-50 px-4 py-2 text-center text-sm dark:bg-blue-950/40">
      <div className="mx-auto flex max-w-[1448px] flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-2 text-blue-700 dark:text-blue-900">
          <SparklesFilled className="size-4 shrink-0" />
          <span>
            Viewing Workflow {PRE_RELEASE_VERSION.id.replace(/^v/, '')}{' '}
            (Pre-release) Documentation.
          </span>
        </div>
        <Link
          className="font-medium text-blue-700 underline underline-offset-4 decoration-blue-700/40 transition-colors hover:decoration-blue-700 dark:text-blue-900 dark:decoration-blue-900/40 dark:hover:decoration-blue-900"
          href={latestHref}
        >
          Go to Workflow {LATEST_VERSION.id.replace(/^v/, '')} (Latest)
        </Link>
      </div>
    </div>
  );
};
