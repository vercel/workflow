'use client';

import { clsx } from 'clsx';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import styles from '../trace-viewer.module.css';

// Color token mapping helper
const colorTokenMap: Record<string, string> = {
  'gray-700': 'var(--ds-gray-700)',
  'gray-900': 'var(--ds-gray-900)',
};

export function IconCross({
  size = 16,
  color = 'gray-700',
}: {
  size?: number;
  color?: string;
}): ReactNode {
  const style = { color: colorTokenMap[color] || color } as const;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={style}
      aria-hidden
    >
      <title>Cross</title>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconChevronDown({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={styles.detailHeadingIcon}
    >
      <title>Chevron Down</title>
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconExternalSmall({
  size = 16,
  color = 'gray-900',
}: {
  size?: number;
  color?: string;
}): ReactNode {
  const style = { color: colorTokenMap[color] || color } as const;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={style}
      aria-hidden
    >
      <title>External Small</title>
      <path
        d="M14 4h6m0 0v6m0-6L10 14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Link(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & { as?: 'a' | 'span' }
): ReactNode {
  const { as: asProp, className, href, children, ...rest } = props;
  const Element: any = asProp || 'a';
  if (Element === 'span' || !href) {
    return (
      <span className={className} {...rest}>
        {children}
      </span>
    );
  }
  return (
    <a className={className} href={href} {...rest}>
      {children}
    </a>
  );
}

export function ButtonLink(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & {
    size?: 'small' | 'medium' | 'large';
  }
): ReactNode {
  const { className, children, size: _size, ...rest } = props;
  return (
    <a {...rest} className={clsx(styles.buttonLink, className)}>
      {children}
    </a>
  );
}

export function Note({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return <div className={clsx(styles.note, className)}>{children}</div>;
}

export function Skeleton({
  width,
  height,
  rounded,
}: {
  width: number;
  height: number;
  rounded?: boolean;
}): ReactNode {
  return (
    <span
      className={clsx(styles.skeleton, rounded && styles.skeletonRounded)}
      style={{ width, height }}
      aria-hidden
    />
  );
}
