'use client';

import { cn } from '../../lib/cn';
import {
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
} from './collapsible';
import { Note, NoteContent } from './note';

interface ErrorCardProps {
  /** Title shown in the header */
  title: string;
  /** Error message or details to show when expanded */
  details?: string;
  /** Additional class names */
  className?: string;
}

/**
 * An error `Note` with the title always visible and the details behind a
 * "Details" disclosure.
 */
export function ErrorCard({
  title,
  className,
  details = 'Unknown error',
}: ErrorCardProps) {
  return (
    <Note
      variant="error"
      role="alert"
      className={cn('mx-auto max-w-[800px]', className)}
    >
      <NoteContent className="font-medium">{title}</NoteContent>
      {details ? (
        <CollapsibleRoot variant="inline">
          <CollapsibleTrigger className="text-label-13">
            Details
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="m-0 mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[4px] bg-red-100 p-3 text-label-12-mono">
              {details}
            </pre>
          </CollapsibleContent>
        </CollapsibleRoot>
      ) : null}
    </Note>
  );
}
