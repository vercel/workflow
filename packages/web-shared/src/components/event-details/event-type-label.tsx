'use client';

import { cn } from '../../lib/cn';
import { EventNoticeTooltip } from '../ui/duplicate-event-tooltip';

/**
 * An event's type, or another label for the event such as its name. An
 * event the runtime ignores (a duplicate, or a sealed `noop`) is struck
 * through and explains why on hover; callers mute its colour
 * (`text-gray-700`). The native title always shows the event type.
 */
export function EventTypeLabel({
  eventType,
  label = eventType,
  notice,
  className,
}: {
  eventType: string;
  /** Text to show instead of the event type. */
  label?: string;
  /** Why the event is ignored, when it is. */
  notice?: string;
  className?: string;
}) {
  return (
    <EventNoticeTooltip notice={notice}>
      <span
        className={cn('truncate', notice && 'line-through', className)}
        title={eventType}
      >
        {label}
      </span>
    </EventNoticeTooltip>
  );
}
