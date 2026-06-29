import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

const kbdVariants = cva(
  'inline-flex items-center justify-center rounded px-1 text-center font-sans',
  {
    variants: {
      variant: {
        subtle: 'bg-background-100/20',
        outline:
          'border border-gray-alpha-400 bg-background-100 font-medium text-gray-900',
      },
      size: {
        default: 'h-5 min-w-5 text-xs leading-none',
        compact: 'h-4 min-h-4 min-w-4 text-[11px] leading-none',
        search: 'h-5 min-h-5 min-w-5 text-[13px] leading-[1.7em]',
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

export { kbdVariants };
