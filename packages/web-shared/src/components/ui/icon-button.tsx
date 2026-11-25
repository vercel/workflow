import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../../lib/cn';

const iconButtonVariants = cva(
  [
    'm-0 inline-flex shrink-0 appearance-none items-center justify-center border-0 bg-transparent p-0 align-baseline no-underline [-webkit-appearance:none] [-webkit-tap-highlight-color:transparent]',
    'transition-colors duration-150 ease-in-out',
    'enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
    'outline-none focus-visible:shadow-[var(--ds-focus-ring)]',
  ],
  {
    variants: {
      variant: {
        tertiary:
          'text-gray-1000 enabled:hover:bg-gray-alpha-200 enabled:active:bg-gray-alpha-200',
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
