'use client';

import { AlertCircle, ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../../lib/cn';

interface ErrorCardProps {
  /** Title shown in the header */
  title: string;
  /** Error message or details to show when expanded */
  details?: string;
  /** Additional class names */
  className?: string;
}

/**
 * A collapsible error card that shows a title with an error icon,
 * and expands to reveal details when clicked.
 */
export function ErrorCard({
  title,
  className,
  details = 'Unknown error',
}: ErrorCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const detailsId = useId();

  return (
    <div className="flex w-full justify-center">
      <div
        className={cn(
          'w-full max-w-[800px] rounded-md border border-red-400 bg-red-100',
          className
        )}
      >
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          aria-controls={detailsId}
          className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border-0 bg-transparent px-4 py-3 text-left text-red-900 outline-none focus-visible:shadow-[var(--ds-focus-ring)]"
        >
          <span className="flex min-w-0 items-center gap-2">
            <AlertCircle className="size-4 shrink-0" aria-hidden />
            <span className="truncate text-label-14 font-medium">{title}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-label-13">
            {isExpanded ? 'Hide Details' : 'Show Details'}
            <ChevronDown
              aria-hidden
              className={cn(
                'size-4 transition-transform duration-200 motion-reduce:transition-none',
                isExpanded && 'rotate-180'
              )}
            />
          </span>
        </button>

        {isExpanded && details && (
          <div id={detailsId} className="border-t border-red-400 px-4 pb-3">
            <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-md bg-red-200 p-3 text-label-12-mono text-red-900">
              {details}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
