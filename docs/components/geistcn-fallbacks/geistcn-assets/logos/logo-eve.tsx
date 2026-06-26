/**
 * Temporary eve logo fallback.
 *
 * Hard-copied from `@vercel/geistcn-assets` (LogoEve). Uses `currentColor`
 * so it adapts to light/dark themes without separate variants.
 */
export function LogoEve({
  height = 14,
  className,
}: {
  height?: number;
  className?: string;
}) {
  const width = (169 / 53) * height;
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={height}
      role="img"
      viewBox="0 0 169 53"
      width={width}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M169 8.47h-51.39L81.73 53H70.36L113 0H169zM169 44.51v8.47h-45.87V44.5zM45.87 52.98H0V44.5h45.87zM38.66 30.55H0v-8.47h38.66z"
        fill="currentColor"
      />
      <path
        d="M169 30.55h-38.66v-8.47H169zM75.52 8.47H0V0h75.52z"
        fill="currentColor"
      />
    </svg>
  );
}
