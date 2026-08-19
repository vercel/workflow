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
 * Explains why an event row is shown greyed out — a repeat the runtime read
 * past ({@link DUPLICATE_EVENT_MESSAGE}), a backend seal for an abandoned
 * position (`SEALED_EVENT_MESSAGE`), or any other notice a list attaches.
 *
 * Renders `children` untouched when `notice` is absent, so a call site can
 * wrap an event label unconditionally. Mounts its own {@link TooltipProvider}
 * so it works in the sidebar and the events table alike; nesting one inside
 * an existing provider is harmless.
 */
export function EventNoticeTooltip({
  notice,
  children,
}: {
  notice?: string;
  children: ReactNode;
}): ReactNode {
  if (!notice) return children;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          className="max-w-[264px] leading-snug"
          collisionPadding={8}
          side="top"
        >
          {notice}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The duplicate-specific wrapper kept for existing call sites: greys the
 * event out as a repeat the runtime read past.
 */
export function DuplicateEventTooltip({
  isDuplicate = false,
  children,
}: {
  isDuplicate?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <EventNoticeTooltip
      notice={isDuplicate ? DUPLICATE_EVENT_MESSAGE : undefined}
    >
      {children}
    </EventNoticeTooltip>
  );
}
