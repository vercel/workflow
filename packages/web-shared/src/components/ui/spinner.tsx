import type * as React from 'react';
import { cn } from '../../lib/cn';

/** geistcn's named spinner sizes, in pixels. */
const NAMED_SIZES = {
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 40,
  '4xl': 56,
} as const;

export type SpinnerSize = keyof typeof NAMED_SIZES;

export type SpinnerProps = Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  'color'
> & {
  /** A geistcn size name (`sm` is 12px, `md` 16px, …) or a size in pixels. */
  size?: SpinnerSize | number;
  /**
   * Line colour. Prefer a text colour class in `className`: the lines paint
   * with `currentColor`, which defaults to `text-gray-700`.
   */
  color?: string;
};

/**
 * Spinner matching Geist's multi-line fade spinner.
 * At size ≤12: 8 lines, ≤16: 10 lines, else: 12 lines.
 *
 * The fade uses geistcn's `spinner-opacity` keyframes, which the Vercel
 * dashboard already ships and our `styles.css` defines for everyone else, so
 * nothing is injected at render time.
 */
export function Spinner({
  size = 14,
  color,
  className,
  style,
  ...props
}: SpinnerProps) {
  const px = typeof size === 'number' ? size : NAMED_SIZES[size];
  const config =
    px <= 12
      ? {
          angle: 45,
          delays: [-875, -750, -625, -500, -375, -250, -125, 0],
          duration: 1000,
          lineW: 3,
          lineH: 1.5,
        }
      : px <= 16
        ? {
            angle: 36,
            delays: [-900, -800, -700, -600, -500, -400, -300, -200, -100, 0],
            duration: 1000,
            lineW: 4,
            lineH: 1.5,
          }
        : {
            angle: 30,
            delays: [
              -1100, -1000, -900, -800, -700, -600, -500, -400, -300, -200,
              -100, 0,
            ],
            duration: 1200,
            lineW: px * 0.24,
            lineH: px * 0.08,
          };

  return (
    // biome-ignore lint/a11y/useSemanticElements: geistcn's Spinner is a status region too; <output> is a form control
    <span
      role="status"
      aria-label="Loading"
      className={cn('relative inline-flex shrink-0 text-gray-700', className)}
      style={{ width: px, height: px, color, ...style }}
      {...props}
    >
      {config.delays.map((delay, i) => (
        <span
          key={delay}
          aria-hidden="true"
          className="absolute top-1/2 left-1/2 rounded-[1px] bg-current [animation-iteration-count:infinite] [animation-name:spinner-opacity] [animation-timing-function:linear]"
          style={{
            width: config.lineW,
            height: config.lineH,
            marginLeft: -config.lineW / 2,
            marginTop: -config.lineH / 2,
            transform: `rotate(${i * config.angle}deg) translate(${px * 0.36}px)`,
            animationDuration: `${config.duration}ms`,
            animationDelay: `${delay}ms`,
          }}
        />
      ))}
    </span>
  );
}
