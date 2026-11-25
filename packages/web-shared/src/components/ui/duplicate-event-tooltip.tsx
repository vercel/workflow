'use client';

import type { ReactNode } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip';

/**
 * Explains why an event row is shown greyed out, whether it is a repeat the
 * runtime read past (`DUPLICATE_EVENT_MESSAGE`), a backend seal for an
 * abandoned position (`SEALED_EVENT_MESSAGE`), or any other notice a list
 * attaches.
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
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent collisionPadding={8} side="top">
          {notice}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
