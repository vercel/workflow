'use client';

import { AlertCircle, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/utils';

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
          'rounded-lg border border-red-400 w-full max-w-[800px]',
          className
        )}
        style={{ background: 'var(--ds-red-100)' }}
      >
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full px-4 py-3 flex items-center justify-between gap-2 text-left transition-colors"
          style={{ color: 'var(--ds-red-900)' }}
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
          <div
            className="px-4 pb-3"
            style={{ borderTop: '1px solid var(--ds-red-400)' }}
          >
            <pre
              className="mt-3 p-3 rounded-md text-xs font-mono whitespace-pre-wrap break-words overflow-auto"
              style={{
                background: 'var(--ds-red-200)',
                color: 'var(--ds-red-900)',
              }}
            >
              {details}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
