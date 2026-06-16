import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../../lib/utils';

const iconButtonVariants = cva(
  [
    'm-0 inline-flex shrink-0 appearance-none items-center justify-center border-0 bg-transparent p-0 align-baseline font-inherit no-underline [background:none] [-webkit-appearance:none] [-webkit-tap-highlight-color:transparent]',
    'transition-colors duration-150 ease-in-out',
    'enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-40',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ds-focus-color)] focus-visible:outline-offset-2',
  ],
  {
    variants: {
      variant: {
        tertiary:
          'text-gray-900 enabled:hover:bg-gray-alpha-200 enabled:hover:text-gray-1000 enabled:active:bg-gray-alpha-200 focus-visible:text-gray-1000',
        muted:
          'text-gray-900 enabled:hover:bg-gray-alpha-200 enabled:hover:text-gray-1000 enabled:active:bg-gray-alpha-200 focus-visible:text-gray-1000',
      },
      size: {
        tiny: 'h-6 w-6 rounded-[4px] [&_svg]:h-4 [&_svg]:w-4',
        small: 'h-8 w-8 rounded-md [&_svg]:h-4 [&_svg]:w-4',
      },
    },
    defaultVariants: {
      variant: 'tertiary',
      size: 'tiny',
    },
  }
);

export type IconButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'type'
> &
  VariantProps<typeof iconButtonVariants> & {
    'aria-label': string;
    type?: 'button' | 'submit' | 'reset';
  };

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(iconButtonVariants({ variant, size, className }))}
      {...props}
    />
  )
);
IconButton.displayName = 'IconButton';

export { iconButtonVariants };
