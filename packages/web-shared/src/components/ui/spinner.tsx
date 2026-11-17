import { cva } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/cn';

const sizeConfig = {
  sm: {
    angleIncrement: 45,
    lineDimensions: 'h-[1.5px] w-[3px]',
    delays: [-875, -750, -625, -500, -375, -250, -125, 0],
    duration: 1000,
  },
  md: {
    angleIncrement: 36,
    lineDimensions: 'h-[1.5px] w-1',
    delays: [-900, -800, -700, -600, -500, -400, -300, -200, -100, 0],
    duration: 1000,
  },
  lg: {
    angleIncrement: 30,
    lineDimensions: 'h-[2px] w-[5px]',
    delays: [
      -1100, -1000, -900, -800, -700, -600, -500, -400, -300, -200, -100, 0,
    ],
    duration: 1200,
  },
  xl: {
    angleIncrement: 30,
    lineDimensions: 'h-[2.5px] w-1.5',
    delays: [
      -1100, -1000, -900, -800, -700, -600, -500, -400, -300, -200, -100, 0,
    ],
    duration: 1200,
  },
  '2xl': {
    angleIncrement: 24,
    lineDimensions: 'h-[2.5px] w-2',
    delays: [
      -1120, -1040, -960, -880, -800, -720, -640, -560, -480, -400, -320, -240,
      -160, -80, 0,
    ],
    duration: 1200,
  },
  '3xl': {
    angleIncrement: 24,
    lineDimensions: 'h-[3px] w-2.5',
    delays: [
      -1120, -1040, -960, -880, -800, -720, -640, -560, -480, -400, -320, -240,
      -160, -80, 0,
    ],
    duration: 1200,
  },
  '4xl': {
    angleIncrement: 20,
    lineDimensions: 'h-[3.5px] w-3.5',
    delays: [
      -1228, -1156, -1083, -1011, -939, -867, -794, -722, -650, -578, -506,
      -433, -361, -289, -217, -144, -72, 0,
    ],
    duration: 1300,
  },
} as const;

export type SpinnerSize = keyof typeof sizeConfig;

const spinnerVariants = cva(
  'relative inline-block aspect-square transform-gpu text-gray-700',
  {
    variants: {
      size: {
        sm: 'size-3', // 12px
        md: 'size-4', // 16px
        lg: 'size-5', // 20px
        xl: 'size-6', // 24px
        '2xl': 'size-8', // 32px
        '3xl': 'size-10', // 40px
        '4xl': 'size-14', // 56px
      },
    },
  }
);

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
}

/**
 * Lines that fade in turn around a ring, painted with `currentColor`
 * (`text-gray-700` unless `className` sets another). The fade is the
 * `spinner-opacity` keyframes in our `styles.css`.
 */
export function Spinner({ size = 'lg', className, ...props }: SpinnerProps) {
  const { angleIncrement, lineDimensions, delays, duration } = sizeConfig[size];

  return (
    // biome-ignore lint/a11y/useSemanticElements: a loading indicator is a status region; <output> is a form control
    <span
      role="status"
      aria-label="Loading"
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    >
      {delays.map((delay, index) => (
        <span
          aria-hidden="true"
          key={delay}
          className={cn(
            'absolute top-1/2 left-1/2 origin-center rounded-full bg-current will-change-transform',
            lineDimensions
          )}
          style={{
            animation: `spinner-opacity ${duration}ms linear infinite`,
            animationDelay: `${delay}ms`,
            // Centring lives in the transform rather than translate
            // utilities, which Tailwind v3 compiles to `transform` too.
            transform: `translate(-50%, -50%) rotate(${index * angleIncrement}deg) translate(146%)`,
          }}
        />
      ))}
      <span className="sr-only">Loading...</span>
    </span>
  );
}
