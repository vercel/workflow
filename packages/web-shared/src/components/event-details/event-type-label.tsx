'use client';

import { cn } from '../../lib/cn';
import { EventNoticeTooltip } from '../ui/duplicate-event-tooltip';

/**
 * An event's type. An event the runtime ignores (a duplicate, or a sealed
 * `noop`) is struck through and explains why on hover; callers mute its
 * colour (`text-gray-700`).
 */
export function EventTypeLabel({
  eventType,
  notice,
  className,
}: {
  eventType: string;
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
        {eventType}
      </span>
    </EventNoticeTooltip>
  );
}
