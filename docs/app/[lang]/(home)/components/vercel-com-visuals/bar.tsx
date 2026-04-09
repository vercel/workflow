import { cva, type VariantProps } from 'class-variance-authority';
import type { JSX } from 'react';

const barStyles = cva('flex items-center border border-solid', {
  variants: {
    align: {
      between: 'justify-between',
      center: 'justify-center',
    },
    variant: {
      blue: 'bg-blue-200 text-blue-900 border-blue-700',
      green: 'bg-green-100 text-green-900 border-green-600',
      amber: 'bg-amber-100 text-amber-900 border-amber-600',
    },
    size: {
      small: 'py-1 px-2 text-copy-13-mono rounded-md md:rounded-lg',
      large:
        'py-2 px-2 md:px-3 lg:px-4 text-body-16 font-mono rounded-md md:rounded-lg',
    },
  },
  defaultVariants: {
    align: 'between',
    variant: 'blue',
    size: 'small',
  },
});

interface BarProps {
  left?: string;
  right: string;
  variant?: VariantProps<typeof barStyles>['variant'];
  size?: VariantProps<typeof barStyles>['size'];
  className?: string;
}

export function Bar({
  left,
  right,
  variant,
  size,
  className,
}: BarProps): JSX.Element {
  return (
    <div
      className={barStyles({
        align: left ? 'between' : 'center',
        className,
        size,
        variant,
      })}
    >
      {left ? <div className="min-w-0 truncate">{left}</div> : null}
      <div>{right}</div>
    </div>
  );
}
