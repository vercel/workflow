/**
 * Fallback for `LogoIconVercel` from `@vercel/geistcn-assets/logos`.
 * Used when the private package is not installed (e.g. external contributors).
 */
export function LogoIconVercel({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      role="img"
      viewBox="0 0 16 16"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        clipRule="evenodd"
        d="m8 1 8 14H0z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
