'use client';

import type { ReactNode } from 'react';
import { useEffect, useReducer } from 'react';
import { formatRelativeTime, formatTimeAgo, parseDate } from '../../lib/time';
import {
  ContextCardProvider,
  ContextCardTrigger,
  type ContextCardTriggerProps,
  useHasContextCardProvider,
} from './context-card';

interface RelativeTimeOptions {
  alwaysRelative?: boolean;
  verbs?: [future: string, past: string];
}

function useTick(delay: number): void {
  const [, tick] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    const timer = setTimeout(tick, delay);
    return () => clearTimeout(timer);
  });
}

function RelativeTime({
  date,
  alwaysRelative,
  verbs,
}: { date: number } & RelativeTimeOptions): ReactNode {
  const now = Date.now();
  useTick(Math.abs(now - date) < 60_000 ? 1000 : 60_000);

  const text = formatRelativeTime(date, now, alwaysRelative);
  return verbs ? `${verbs[date > now ? 0 : 1]} ${text.toLowerCase()}` : text;
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

function TimeCard({ date, prefix }: { date: number; prefix?: string }) {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useTick(1000);
  const timeAgo = formatTimeAgo(date, Date.now());

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
// TimestampTooltip: convenience wrapper used across the observability UI
// ---------------------------------------------------------------------------

/**
 * Wraps a timestamp display with a relative-time hover card, or renders a
 * relative time label when it has no children. Self-mounts a
 * {@link ContextCardProvider} when one isn't already present so it works
 * anywhere, but shares a provider (enabling the animated card morph between
 * adjacent timestamps) when rendered inside one.
 */
export function TimestampTooltip({
  date,
  children,
  side = 'top',
  prefix,
  ...relativeTimeOptions
}: {
  date: number | Date | string | null | undefined;
  children?: ReactNode;
  side?: ContextCardTriggerProps['side'];
  prefix?: string;
} & RelativeTimeOptions): ReactNode {
  const hasProvider = useHasContextCardProvider();
  const ts = parseDate(date)?.getTime();

  if (ts === undefined) return children;

  const card = (
    <ContextCardTrigger
      content={<TimeCard date={ts} prefix={prefix} />}
      side={side}
      asChild
    >
      {children ?? (
        <span>
          <RelativeTime date={ts} {...relativeTimeOptions} />
        </span>
      )}
    </ContextCardTrigger>
  );

  return hasProvider ? card : <ContextCardProvider>{card}</ContextCardProvider>;
}
