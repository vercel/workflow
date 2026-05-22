/**
 * Temporary Streamdown logo fallback.
 */
export function LogoStreamdown({ height = 14 }: { height?: number }) {
  return (
    <span
      className="font-semibold text-gray-1000 leading-none tracking-[-0.02em]"
      style={{ fontSize: height }}
    >
      Streamdown
    </span>
  );
}
