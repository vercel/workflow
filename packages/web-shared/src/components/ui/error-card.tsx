'use client';

import { AlertCircle, ChevronDown } from 'lucide-react';
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
          'w-full max-w-[800px] rounded-lg border border-red-400 bg-red-100',
          className
        )}
      >
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-red-900 transition-colors"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="font-medium text-sm">{title}</span>
          </div>
          <div className="flex items-center gap-1.5 opacity-70">
            <span className="text-xs">Click to show details</span>
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform duration-200',
                isExpanded && 'rotate-180'
              )}
            />
          </div>
        </button>

        {isExpanded && details && (
          <div className="border-red-400 border-t px-4 pb-3">
            <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-md bg-red-200 p-3 font-mono text-red-900 text-xs">
              {details}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
