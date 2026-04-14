export function IconFileText({
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
        d="M9.18 0a1 1 0 0 1 .61.3l4.42 4.4a1 1 0 0 1 .29.71v8.09A2.5 2.5 0 0 1 12 16H4a2.5 2.5 0 0 1-2.5-2.5V0h7.69M3 13.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.62L8.88 1.5H3zm8.63-1.25H4.5V11h7.13zm0-3H4.5V8h7.13zm-5-3H4.5V5h2.13z"
        fill="currentColor"
      />
    </svg>
  );
}
