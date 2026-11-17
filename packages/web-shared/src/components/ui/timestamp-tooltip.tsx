'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import {
  formatRelativeTimeDetailed,
  formatZonedDateTime,
  parseDateValue,
} from '../../lib/time';
import {
  ContextCardProvider,
  ContextCardTrigger,
  type ContextCardTriggerProps,
  useHasContextCardProvider,
} from './context-card';

/**
 * Detailed relative time string that auto-updates every second
 * (e.g. "2 hours, 15 minutes, 30 seconds ago"). Used inside the hover card.
 */
export function useTimeAgo(date: number): string {
  const [timeAgo, setTimeAgo] = useState<string>('');

  useEffect(() => {
    const updateTimeAgo = (): void => {
      setTimeAgo(formatRelativeTimeDetailed(new Date(date)));
    };

    updateTimeAgo();
    const timer = setInterval(updateTimeAgo, 1000);
    return () => clearInterval(timer);
  }, [date]);

  return timeAgo;
}

// ---------------------------------------------------------------------------
// Hover card content
// ---------------------------------------------------------------------------

function ZoneDateTimeRow({
  date,
  zone,
}: {
  zone: string;
  date: number;
}): ReactNode {
  const formatted = formatZonedDateTime(new Date(date), zone);

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <div className="flex items-center justify-center h-4 px-1.5 bg-gray-200 rounded-xs">
          <span className="text-label-12-mono text-gray-900">
            {formatted.zone}
          </span>
        </div>
        <span className="text-label-13 text-gray-1000">{formatted.date}</span>
      </div>
      <span className="tabular-nums text-label-12-mono text-gray-900">
        {formatted.time}
      </span>
    </div>
  );
}

function RelativeTimeContextCardContent({
  date,
  prefix,
}: {
  date: number;
  prefix?: string;
}): ReactNode {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeAgo = useTimeAgo(date);

  return (
    <div className="flex flex-col gap-3 min-w-[300px]">
      <div className="flex flex-col gap-3">
        <span className="tabular-nums text-label-13 text-gray-900">
          {prefix ? `${prefix} ${timeAgo}` : timeAgo}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <ZoneDateTimeRow date={date} zone="UTC" />
        <ZoneDateTimeRow date={date} zone={localTimezone} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RelativeTimeCard
// ---------------------------------------------------------------------------

type RelativeTimeCardProps = Omit<
  ContextCardTriggerProps,
  'content' | 'children'
> & {
  /** Timestamp in milliseconds to describe in the card. */
  date?: number | null;
  /** The trigger: an already-formatted timestamp. */
  children: ReactNode;
  prefix?: string;
};

/**
 * Reveals a context card with the relative time and detailed UTC and local
 * timestamps when `children` is hovered; renders only the children when
 * `date` is nullish.
 */
export function RelativeTimeCard({
  date,
  children,
  prefix,
  ...props
}: RelativeTimeCardProps): ReactNode {
  if (!date) return children;

  return (
    <ContextCardTrigger
      content={<RelativeTimeContextCardContent date={date} prefix={prefix} />}
      {...props}
    >
      {children}
    </ContextCardTrigger>
  );
}

// ---------------------------------------------------------------------------
// TimestampTooltip: convenience wrapper used across the observability UI
// ---------------------------------------------------------------------------

/**
 * Wraps an already-formatted timestamp display with a relative-time hover
 * card. Self-mounts a {@link ContextCardProvider} when one isn't already
 * present so it works anywhere, but shares a provider (enabling the animated
 * card morph between adjacent timestamps) when rendered inside one.
 */
export function TimestampTooltip({
  date,
  children,
  side = 'top',
  prefix,
}: {
  date: number | Date | string | null | undefined;
  children: ReactNode;
  side?: ContextCardTriggerProps['side'];
  prefix?: string;
}): ReactNode {
  const hasProvider = useHasContextCardProvider();

  const ts = parseDateValue(date)?.getTime();

  if (ts == null) return <>{children}</>;

  const card = (
    <RelativeTimeCard date={ts} side={side} prefix={prefix} asChild>
      {children}
    </RelativeTimeCard>
  );

  return hasProvider ? card : <ContextCardProvider>{card}</ContextCardProvider>;
}
