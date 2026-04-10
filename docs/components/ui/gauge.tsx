import React, { useMemo, type JSX } from 'react';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

type ColorObject =
  | Record<number, string>
  | {
      primary: string;
      secondary?: string;
    };

const DEFAULT_COLORS: ColorObject = {
  // Level: Poor
  '0': 'var(--ds-red-800)',
  // Level: Okay
  '33': 'var(--ds-amber-700)',
  // Level: Good
  '66': 'var(--ds-green-700)',
};

export interface GaugeProps {
  /** The value for the gauge. This needs to be a number between 0 and 100 representing 0% to 100%. */
  value: number;
  /** Determines whether the value is displayed as a number. */
  showValue?: boolean;
  /** Either color stops the gauge should be based on `value`, or static colors. */
  colors?: ColorObject;
  size: 'tiny' | 'small' | 'medium' | 'large';
  /* Decides which arc should be prioritized. Use `equal` when displaying a ratio and `primary` when displaying a single percentage. `equal` leads to both arcs being the exact same size at 50. */
  arcPriority?: 'equal' | 'primary';
  placeholder?: boolean;
  indeterminate?: boolean;
  className?: string;
  children?: React.ReactNode;
  style?: CSSProperties;
}

const GaugeSizeMapping: Record<GaugeProps['size'], number> = {
  tiny: 20,
  small: 32,
  medium: 64,
  large: 128,
};

const GaugeGapMapping: Record<GaugeProps['size'], number> = {
  tiny: 3,
  small: 2,
  medium: 1,
  large: 1,
};

const FontConfigMapping: Record<
  GaugeProps['size'],
  {
    size: number;
    weight: number;
  } | null
> = {
  tiny: null,
  small: {
    size: 11,
    weight: 500,
  },
  medium: {
    size: 18,
    weight: 500,
  },
  large: {
    size: 32,
    weight: 600,
  },
};

const CIRCLE_SIZE = 100;

export function Gauge({
  colors = DEFAULT_COLORS,
  value,
  placeholder: _placeholder,
  indeterminate,
  className,
  arcPriority = 'primary',
  style,
  size: sizeLabel,
  children,
  showValue = false,
  ...props
}: GaugeProps): JSX.Element {
  const placeholder = _placeholder || false;
  const size = GaugeSizeMapping[sizeLabel];
  const textConfig = FontConfigMapping[sizeLabel];

  // Gets the color for the current value based on the color map.
  const [primaryColor, secondaryColor] = useMemo<
    Readonly<[string | undefined, string | undefined]>
  >(() => {
    if ('primary' in colors) {
      return [colors.primary, colors.secondary] as const;
    }

    const stops = Object.keys(colors).map(Number);
    if (stops.length === 0) return [undefined, undefined] as const;

    const c = stops.filter((stop) => value >= stop).pop();

    return [c !== undefined ? colors[c] : undefined, undefined] as const;
  }, [colors, value]);

  // Calculates arc & circle values based on the current size & value.
  const arcValues = useMemo(() => {
    const strokeWidth = size <= GaugeSizeMapping.tiny ? 15 : 10;

    const circumference = 2 * Math.PI * (CIRCLE_SIZE / 2 - strokeWidth / 2);
    const pxToPercent = CIRCLE_SIZE / circumference;

    const circleProps: React.SVGProps<SVGCircleElement> = {
      cx: CIRCLE_SIZE / 2,
      cy: CIRCLE_SIZE / 2,
      r: CIRCLE_SIZE / 2 - strokeWidth / 2,
      strokeWidth,
      strokeDashoffset: 0,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    };

    const baseGap = Math.round(strokeWidth * pxToPercent);

    let segmentGap = baseGap + GaugeGapMapping[sizeLabel];

    if (value === 0 || value >= 100) {
      segmentGap = 0;
    }

    const offsetFactor = arcPriority === 'equal' ? 0.5 : 0;

    const primaryStrokePercent = value - segmentGap * 2 * offsetFactor;

    const diffToOnePercent = Math.max(1 - primaryStrokePercent, 0);

    const secondaryStrokePercent =
      100 - value - segmentGap * 2 * (1 - offsetFactor) - diffToOnePercent;

    return {
      circleProps,
      circumference,
      segmentGap,
      primaryStrokePercent,
      secondaryStrokePercent,
      offsetFactor,
    };
  }, [arcPriority, size, sizeLabel, value]);

  const {
    circleProps,
    circumference,
    offsetFactor,
    segmentGap,
    primaryStrokePercent,
    secondaryStrokePercent,
  } = arcValues;

  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={indeterminate ? undefined : value}
      className={cn(
        'relative flex flex-col justify-center items-center [&_svg]:overflow-visible',
        '[--transition-length:1s] [--transition-step:200ms] [--delay:0s] [--percent-to-deg:3.6deg] transform-gpu',
        indeterminate ? '[&_circle]:!stroke-[var(--ds-gray-alpha-400)]' : '',
        className
      )}
      data-geist-progress-circle=""
      data-version="v1"
      role="progressbar"
      style={{
        ...style,
        ['--circle-size' as string]: `${CIRCLE_SIZE}px`,
        ['--circumference' as string]: circumference,
        ['--percent-to-px' as string]: `${circumference / 100}px`,
        ['--gap-percent' as string]: segmentGap,
        ['--offset-factor' as string]: offsetFactor,
      }}
      {...props}
    >
      <svg
        aria-hidden
        fill="none"
        height={size}
        strokeWidth="2"
        viewBox={`0 0 ${CIRCLE_SIZE} ${CIRCLE_SIZE}`}
        width={size}
      >
        <circle
          style={{
            opacity: secondaryStrokePercent < 0 || value === 100 ? 0 : 1,
            ['--stroke-percent' as string]: secondaryStrokePercent,
          }}
          {...circleProps}
          className={cn(
            !placeholder
              ? [
                  '[--offset-factor-secondary:calc(1-var(--offset-factor))]',
                  '[stroke-dasharray:calc(var(--stroke-percent)*var(--percent-to-px))_var(--circumference)]',
                  '[transform:rotate(calc(360deg-90deg-(var(--gap-percent)*var(--percent-to-deg)*var(--offset-factor-secondary))))_scaleY(-1)] [transform-origin:calc(var(--circle-size)/2)_calc(var(--circle-size)/2)]',
                  '[transition:all_var(--transition-length)_ease_var(--delay)]',
                ]
              : '',
            indeterminate ? '!opacity-0 [--stroke-percent:0_!important]' : ''
          )}
          stroke={secondaryColor || 'var(--ds-gray-alpha-400)'}
        />
        <circle
          {...circleProps}
          className={cn(
            !placeholder
              ? [
                  '[stroke-dasharray:calc(var(--stroke-percent)*var(--percent-to-px))_var(--circumference)]',
                  '[transition-property:stroke-dasharray,transform] [transition:var(--transition-length)_ease_var(--delay),stroke_var(--transition-length)_ease_var(--delay)]',
                  '[transform:rotate(calc(-90deg+var(--gap-percent)*var(--offset-factor)*var(--percent-to-deg)))] [transform-origin:calc(var(--circle-size)/2)_calc(var(--circle-size)/2)]',
                ]
              : '',
            indeterminate ? '[--stroke-percent:100_!important]' : ''
          )}
          data-geist-progress-circle-fg=""
          stroke={primaryColor || 'var(--geist-foreground)'}
          style={{
            opacity: value === 0 ? 0 : 1,
            ['--stroke-percent' as string]: Math.min(
              100 - segmentGap,
              primaryStrokePercent
            ),
          }}
        />
      </svg>

      {children || showValue ? (
        <div aria-hidden className="flex absolute">
          {children ||
            (textConfig && (
              <p
                className="text-inherit"
                style={{
                  fontSize: textConfig.size,
                  fontWeight: textConfig.weight,
                }}
              >
                {value}
              </p>
            ))}
        </div>
      ) : null}
    </div>
  );
}
