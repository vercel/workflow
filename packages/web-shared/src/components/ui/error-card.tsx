'use client';

import { ChevronDown, OctagonAlert } from 'lucide-react';
import { useState } from 'react';
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

  return (
    <div className="flex justify-center w-full">
      <div
        className={cn(
          'rounded-md border border-red-100 bg-red-200 w-full max-w-[800px]',
          className
        )}
      >
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full min-h-(--ds-size-medium) px-3 py-1.5 flex items-center justify-between gap-3 text-left text-red-900"
        >
          <div className="flex items-center gap-3">
            <OctagonAlert className="size-3.5 shrink-0" />
            <span className="text-copy-14 font-semibold">{title}</span>
          </div>
          <div className="flex items-center gap-1.5 text-red-800">
            <span className="text-label-12">
              {isExpanded ? 'Hide details' : 'Show details'}
            </span>
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform duration-200',
                isExpanded && 'rotate-180'
              )}
            />
          </div>
        </button>

        {isExpanded && details && (
          <div className="px-3 pb-3 border-t border-red-400">
            <pre className="mt-3 p-3 rounded-md border border-red-400 bg-red-300 text-red-1000 text-label-12-mono whitespace-pre-wrap break-words overflow-auto">
              {details}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
