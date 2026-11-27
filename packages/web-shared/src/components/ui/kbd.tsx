import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

const kbdVariants = cva(
  'inline-flex items-center justify-center rounded px-1 text-center font-sans',
  {
    variants: {
      variant: {
        subtle: 'bg-gray-400',
        outline:
          'bg-background-100 font-medium text-gray-900 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]',
      },
      size: {
        default: 'h-5 min-w-5 text-label-12 leading-none',
        compact: 'h-5 min-h-5 min-w-5 text-label-12',
        search: 'h-5 min-h-5 min-w-5 text-label-12',
      },
    },
    defaultVariants: {
      variant: 'subtle',
      size: 'default',
    },
  }
);

type KbdProps = ComponentProps<'kbd'> & VariantProps<typeof kbdVariants>;

export function Kbd({
  children,
  className,
  variant,
  size,
  ...props
}: KbdProps): ReactNode {
  return (
    <kbd className={cn(kbdVariants({ variant, size, className }))} {...props}>
      {children}
    </kbd>
  );
}
