export function IconMenuAlt({
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
        d="M1 2h14v1.5H1zm0 10h14v1.5H1zm.75-5H1v1.5h14V7H1.75"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
