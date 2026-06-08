import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded bg-background-100/20 px-1 text-center font-sans text-xs leading-none',
        className
      )}
    >
      {children}
    </kbd>
  );
}
