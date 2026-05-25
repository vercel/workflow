import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  [
    'outline-none m-0 border-0 align-baseline no-underline group/trigger',
    'relative cursor-pointer select-none transform translate-z-0',
    'inline-flex max-w-full items-center justify-center gap-x-1 whitespace-nowrap rounded-md font-medium',
    '!text-gray-100',
    'bg-gray-1000',
    'transition-[border-color,background,color,transform,box-shadow] duration-150 ease-in-out',
    'hover:bg-[var(--themed-hover-bg,_hsl(0,_0%,_22%))] dark-theme:hover:bg-[var(--themed-hover-bg,_hsl(0,_0%,_80%))]',
    // disabled styles
    'disabled:cursor-not-allowed aria-disabled:cursor-not-allowed',
    'disabled:bg-gray-100 disabled:!text-gray-700 disabled:hover:bg-gray-100',
    'aria-disabled:bg-gray-100 aria-disabled:text-gray-700 aria-disabled:hover:bg-gray-100',
  ],
  {
    variants: {
      variant: {
        default: '',
        secondary:
          'border border-gray-alpha-400 [--themed-bg:_var(--ds-background-100)] [--themed-fg:_var(--ds-gray-1000)] [--themed-hover-bg:_var(--ds-gray-alpha-200)]',
        ghost:
          '[--themed-bg:_transparent] [--themed-fg:_var(--ds-gray-1000)] [--themed-hover-bg:_var(--ds-gray-alpha-100)]',
      },
      size: {
        default: 'h-10 px-4 text-[14px]',
        sm: 'h-8 px-3 text-[14px]',
        xs: 'h-6 px-1.5 py-0.5 text-button-12',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { buttonVariants };
