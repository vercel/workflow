import type { SVGProps } from 'react';

interface IconProps
  extends Omit<
    SVGProps<SVGSVGElement>,
    'width' | 'height' | 'viewBox' | 'fill'
  > {
  color?: string;
  size?: number | string;
}

export function IconSlashForward({
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
      <title>Slash forward icon</title>
      <path
        clipRule="evenodd"
        d="m4.02 15.4.3-.7 6-14 .29-.68 1.37.59-.3.69-6 14-.29.68z"
        fill={color}
        fillRule="evenodd"
      />
    </svg>
  );
}
