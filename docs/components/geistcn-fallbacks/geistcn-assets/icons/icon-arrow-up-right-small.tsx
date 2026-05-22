import type { SVGProps } from 'react';

interface IconProps
  extends Omit<
    SVGProps<SVGSVGElement>,
    'width' | 'height' | 'viewBox' | 'fill'
  > {
  color?: string;
  size?: number | string;
}

export function IconArrowUpRightSmall({
  size = 16,
  color = 'currentColor',
  ...props
}: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      role="img"
      viewBox="0 0 16 16"
      width={size}
      {...props}
    >
      <path
        clipRule="evenodd"
        d="M6.75 4H6v1.5h3.44L5.47 9.47l-.53.53L6 11.06l.53-.53 3.97-3.97V10H12V5a1 1 0 0 0-1-1z"
        fill={color}
        fillRule="evenodd"
      />
    </svg>
  );
}
