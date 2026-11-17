import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Neutral inline notice shown in place of data that has passed its retention
 * window and is no longer available.
 */
export function ExpiredDataNotice({
  children = 'Data expired',
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md bg-gray-100 px-3 py-2 text-copy-13 text-gray-900',
        className
      )}
    >
      <Clock className="size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}
