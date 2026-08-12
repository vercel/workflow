'use client';

import type { ReactNode } from 'react';
import { DUPLICATE_EVENT_MESSAGE } from '../../lib/duplicate-events';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip';

/**
 * Explains why an event is shown greyed out: it repeats a class the log
 * already records for the same entity, after that entity finished.
 *
 * Renders `children` untouched when `isDuplicate` is false, so a call site can
 * wrap an event label unconditionally. Mounts its own {@link TooltipProvider}
 * so it works in the sidebar and the events table alike; nesting one inside an
 * existing provider is harmless.
 */
export function DuplicateEventTooltip({
  isDuplicate = false,
  children,
}: {
  isDuplicate?: boolean;
  children: ReactNode;
}): ReactNode {
  if (!isDuplicate) return children;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          className="max-w-[264px] leading-snug"
          collisionPadding={8}
          side="top"
        >
          {DUPLICATE_EVENT_MESSAGE}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
