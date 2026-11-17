import type * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * Per-size geometry: box size, line count (via the delays), line size, the
 * angle between lines and the length of one fade cycle, in ms.
 */
const SIZES = {
  sm: {
    px: 12,
    w: 3,
    h: 1.5,
    angle: 45,
    duration: 1000,
    delays: [-875, -750, -625, -500, -375, -250, -125, 0],
  },
  md: {
    px: 16,
    w: 4,
    h: 1.5,
    angle: 36,
    duration: 1000,
    delays: [-900, -800, -700, -600, -500, -400, -300, -200, -100, 0],
  },
  lg: {
    px: 20,
    w: 5,
    h: 2,
    angle: 30,
    duration: 1200,
    delays: [
      -1100, -1000, -900, -800, -700, -600, -500, -400, -300, -200, -100, 0,
    ],
  },
  xl: {
    px: 24,
    w: 6,
    h: 2.5,
    angle: 30,
    duration: 1200,
    delays: [
      -1100, -1000, -900, -800, -700, -600, -500, -400, -300, -200, -100, 0,
    ],
  },
  '2xl': {
    px: 32,
    w: 8,
    h: 2.5,
    angle: 24,
    duration: 1200,
    delays: [
      -1120, -1040, -960, -880, -800, -720, -640, -560, -480, -400, -320, -240,
      -160, -80, 0,
    ],
  },
  '3xl': {
    px: 40,
    w: 10,
    h: 3,
    angle: 24,
    duration: 1200,
    delays: [
      -1120, -1040, -960, -880, -800, -720, -640, -560, -480, -400, -320, -240,
      -160, -80, 0,
    ],
  },
  '4xl': {
    px: 56,
    w: 14,
    h: 3.5,
    angle: 20,
    duration: 1300,
    delays: [
      -1228, -1156, -1083, -1011, -939, -867, -794, -722, -650, -578, -506,
      -433, -361, -289, -217, -144, -72, 0,
    ],
  },
} as const;

export type SpinnerSize = keyof typeof SIZES;

/** The named size whose lines suit a box of `px` pixels. */
function sizeForPixels(px: number): SpinnerSize {
  const names = Object.keys(SIZES) as SpinnerSize[];
  return names.find((name) => px <= SIZES[name].px) ?? '4xl';
}

export type SpinnerProps = Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  'color'
> & {
  /**
   * A named size (`sm` is 12px, `md` 16px, `lg` 20px, `xl` 24px, `2xl` 32px,
   * `3xl` 40px, `4xl` 56px) or a box size in pixels, which uses the lines of
   * the nearest named size at or above it.
   */
  size?: SpinnerSize | number;
  /**
   * Line colour. Prefer a text colour class in `className`: the lines paint
   * with `currentColor`, which defaults to `text-gray-700`.
   */
  color?: string;
};

/**
 * A ring of lines that fade in turn. The fade is the `spinner-opacity`
 * keyframes defined in our `styles.css`, so nothing is injected at render time.
 */
export function Spinner({
  size = 'lg',
  color,
  className,
  style,
  ...props
}: SpinnerProps) {
  const config = SIZES[typeof size === 'number' ? sizeForPixels(size) : size];
  const px = typeof size === 'number' ? size : config.px;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a loading indicator is a status region; <output> is a form control
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'relative inline-block shrink-0 transform-gpu text-gray-700',
        className
      )}
      style={{ width: px, height: px, color, ...style }}
      {...props}
    >
      {config.delays.map((delay, i) => (
        <span
          key={delay}
          aria-hidden="true"
          className="absolute top-1/2 left-1/2 rounded-full bg-current will-change-transform [animation-iteration-count:infinite] [animation-name:spinner-opacity] [animation-timing-function:linear]"
          style={{
            width: config.w,
            height: config.h,
            // Centre the line on the box, turn it, then push it out along its
            // own length.
            transform: `translate(-50%, -50%) rotate(${i * config.angle}deg) translate(146%)`,
            animationDuration: `${config.duration}ms`,
            animationDelay: `${delay}ms`,
          }}
        />
      ))}
    </span>
  );
}
