'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import {
  ContextCardProvider,
  ContextCardTrigger,
  type ContextCardTriggerProps,
  useHasContextCardProvider,
} from './context-card';

// ---------------------------------------------------------------------------
// Time formatting helpers
// ---------------------------------------------------------------------------

interface TimeUnit {
  unit: Intl.RelativeTimeFormatUnit;
  ms: number;
}

const TIME_UNITS: TimeUnit[] = [
  { unit: 'year', ms: 31536000000 },
  { unit: 'month', ms: 2628000000 },
  { unit: 'day', ms: 86400000 },
  { unit: 'hour', ms: 3600000 },
  { unit: 'minute', ms: 60000 },
  { unit: 'second', ms: 1000 },
];

function formatTimeDifference(diff: number): string {
  let remaining = Math.abs(diff);
  const result: string[] = [];

  for (const { unit, ms } of TIME_UNITS) {
    const value = Math.floor(remaining / ms);
    if (value > 0 || result.length > 0) {
      result.push(`${value} ${unit}${value !== 1 ? 's' : ''}`);
      remaining %= ms;
    }
    if (result.length === 3) break;
  }

  return result.join(', ');
}

/**
 * Detailed relative time for a `date` relative to `now`, e.g.
 * "2 hours, 15 minutes, 30 seconds ago" for past dates and
 * "in 2 hours, 15 minutes, 30 seconds" for future dates.
 */
export function formatTimeAgo(date: number, now: number): string {
  const diff = now - date;
  const formattedDiff = formatTimeDifference(diff);
  if (!formattedDiff) return 'Just now';
  return diff < 0 ? `in ${formattedDiff}` : `${formattedDiff} ago`;
}

/**
 * Short relative time for a `date` relative to `now`, e.g. "3 days ago" for
 * past dates and "In 3 days" for future dates.
 */
export function formatShortTimeAgo(date: number, now: number): string {
  const diff = now - date;
  const abs = Math.abs(diff);
  const days = Math.floor(abs / (1000 * 60 * 60 * 24));
  const hours = Math.floor(abs / (1000 * 60 * 60));
  const minutes = Math.floor(abs / (1000 * 60));

  let value: string;
  if (days > 0) {
    value = `${days} day${days > 1 ? 's' : ''}`;
  } else if (hours > 0) {
    value = `${hours} hour${hours > 1 ? 's' : ''}`;
  } else if (minutes > 0) {
    value = `${minutes} minute${minutes > 1 ? 's' : ''}`;
  } else {
    return diff < 0 ? 'In less than a minute' : 'Just now';
  }
  return diff < 0 ? `In ${value}` : `${value} ago`;
}

/**
 * Detailed relative time string that auto-updates every second
 * (e.g. "2 hours, 15 minutes, 30 seconds ago", or "in 5 minutes, 3 seconds"
 * for future dates). Used inside the hover card.
 */
export function useTimeAgo(date: number): string {
  const [timeAgo, setTimeAgo] = useState<string>('');

  useEffect(() => {
    const updateTimeAgo = (): void => {
      setTimeAgo(formatTimeAgo(date, Date.now()));
    };

    updateTimeAgo();
    const timer = setInterval(updateTimeAgo, 1000);
    return () => clearInterval(timer);
  }, [date]);

  return timeAgo;
}

/**
 * Short relative time string that auto-updates every minute
 * (e.g. "3 days ago", "5 hours ago", "In 2 hours"). Returns an empty
 * string if `date` is
 * nullish.
 */
export function useShortTimeAgo(date: number | null | undefined): string {
  const [shortTimeAgo, setShortTimeAgo] = useState<string>('');

  useEffect(() => {
    if (!date) {
      setShortTimeAgo('');
      return;
    }

    const updateShortTimeAgo = (): void => {
      setShortTimeAgo(formatShortTimeAgo(date, Date.now()));
    };

    updateShortTimeAgo();
    const timer = setInterval(updateShortTimeAgo, 60000);
    return () => clearInterval(timer);
  }, [date]);

  return shortTimeAgo;
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
  const dateObj = new Date(date);

  const formattedZone =
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'short',
    })
      .formatToParts(dateObj)
      .find((part) => part.type === 'timeZoneName')?.value || zone;

  const formattedDate = dateObj.toLocaleString('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const formattedTime = dateObj.toLocaleTimeString('en-US', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <div className="flex items-center justify-center h-4 px-1.5 bg-gray-200 rounded-xs">
          <span className="text-label-12-mono text-gray-900">
            {formattedZone}
          </span>
        </div>
        <span className="text-label-13 text-gray-1000">{formattedDate}</span>
      </div>
      <span className="tabular-nums text-label-12-mono text-gray-900">
        {formattedTime}
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

function DefaultTimeText({
  date,
}: {
  date: number | null | undefined;
}): ReactNode {
  const shortTimeAgo = useShortTimeAgo(date);
  return <span className="text-label-14 text-gray-900">{shortTimeAgo}</span>;
}

// ---------------------------------------------------------------------------
// RelativeTimeCard
// ---------------------------------------------------------------------------

type RelativeTimeCardProps = Omit<
  ContextCardTriggerProps,
  'content' | 'children'
> & {
  /** Timestamp in milliseconds to display as a relative time. */
  date?: number | null;
  /** Custom content to render instead of the default relative time text. */
  children?: ReactNode;
  prefix?: string;
};

/**
 * Relative time label that reveals a context card with detailed UTC and local
 * timestamps on hover. Renders a default short relative time label (e.g.
 * "3 days ago") when `children` is omitted; renders only the children without
 * the hover card when `date` is nullish.
 */
export function RelativeTimeCard({
  date,
  children: _children,
  prefix,
  ...props
}: RelativeTimeCardProps): ReactNode {
  const children =
    _children === undefined ? <DefaultTimeText date={date} /> : _children;

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

  const ts =
    date == null
      ? null
      : typeof date === 'number'
        ? date
        : new Date(date).getTime();

  if (ts == null || Number.isNaN(ts)) return <>{children}</>;

  const card = (
    <RelativeTimeCard date={ts} side={side} prefix={prefix} asChild>
      {children}
    </RelativeTimeCard>
  );

  return hasProvider ? card : <ContextCardProvider>{card}</ContextCardProvider>;
}
