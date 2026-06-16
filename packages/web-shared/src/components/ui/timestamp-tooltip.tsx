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
 * Detailed relative time string that auto-updates every second
 * (e.g. "2 hours, 15 minutes, 30 seconds ago"). Used inside the hover card.
 */
export function useTimeAgo(date: number): string {
  const [timeAgo, setTimeAgo] = useState<string>('');

  useEffect(() => {
    const updateTimeAgo = (): void => {
      const diff = Date.now() - date;
      const formattedDiff = formatTimeDifference(diff);
      setTimeAgo(formattedDiff ? `${formattedDiff} ago` : 'Just now');
    };

    updateTimeAgo();
    const timer = setInterval(updateTimeAgo, 1000);
    return () => clearInterval(timer);
  }, [date]);

  return timeAgo;
}

/**
 * Short relative time string that auto-updates every minute
 * (e.g. "3 days ago", "5 hours ago"). Returns an empty string if `date` is
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
      const diff = Date.now() - date;
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor(diff / (1000 * 60));

      if (days > 0) {
        setShortTimeAgo(`${days} day${days > 1 ? 's' : ''} ago`);
      } else if (hours > 0) {
        setShortTimeAgo(`${hours} hour${hours > 1 ? 's' : ''} ago`);
      } else if (minutes > 0) {
        setShortTimeAgo(`${minutes} minute${minutes > 1 ? 's' : ''} ago`);
      } else {
        setShortTimeAgo('Just now');
      }
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
  });

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <div className="flex items-center justify-center h-4 px-1.5 bg-gray-200 rounded-xs">
          <span className="text-[12px] font-mono text-gray-900">
            {formattedZone}
          </span>
        </div>
        <span className="text-[13px] text-gray-1000">{formattedDate}</span>
      </div>
      <span className="tabular-nums text-[12px] font-mono text-gray-900">
        {formattedTime}
      </span>
    </div>
  );
}

function RelativeTimeContextCardContent({ date }: { date: number }): ReactNode {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeAgo = useTimeAgo(date);

  return (
    <div className="flex flex-col gap-3 min-w-[300px]">
      <div className="flex flex-col gap-3">
        <span className="tabular-nums text-[13px] text-gray-900">
          {timeAgo}
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
};

/**
 * Relative time label that reveals a context card with detailed UTC and local
 * timestamps on hover. Renders a default short relative time label (e.g.
 * "3 days ago") when `children` is omitted; renders just the children without
 * the hover card when `date` is nullish.
 */
export function RelativeTimeCard({
  date,
  children: _children,
  ...props
}: RelativeTimeCardProps): ReactNode {
  const children =
    _children === undefined ? <DefaultTimeText date={date} /> : _children;

  if (!date) return children;

  return (
    <ContextCardTrigger
      content={<RelativeTimeContextCardContent date={date} />}
      {...props}
    >
      {children}
    </ContextCardTrigger>
  );
}

// ---------------------------------------------------------------------------
// TimestampTooltip — convenience wrapper used across the observability UI
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
}: {
  date: number | Date | string | null | undefined;
  children: ReactNode;
  side?: ContextCardTriggerProps['side'];
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
    <RelativeTimeCard date={ts} side={side} asChild>
      {children}
    </RelativeTimeCard>
  );

  return hasProvider ? card : <ContextCardProvider>{card}</ContextCardProvider>;
}
