'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { formatRelativeTime, parseDate } from '../../lib/time';
import {
  ContextCardProvider,
  ContextCardTrigger,
  type ContextCardTriggerProps,
  useHasContextCardProvider,
} from './context-card';

function RelativeTime({
  date,
  prefix,
}: {
  date: number;
  prefix?: string;
}): ReactNode {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const relativeTime = formatRelativeTime(date, now);
  return prefix ? `${prefix} ${relativeTime}` : relativeTime;
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

  return (
    <div className="flex flex-col gap-3 min-w-[300px]">
      <div className="flex flex-col gap-3">
        <span className="tabular-nums text-label-13 text-gray-900">
          <RelativeTime date={date} prefix={prefix} />
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
}: {
  date: number | Date | string | null | undefined;
  children?: ReactNode;
  side?: ContextCardTriggerProps['side'];
  prefix?: string;
}): ReactNode {
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
          <RelativeTime date={ts} />
        </span>
      )}
    </ContextCardTrigger>
  );

  return hasProvider ? card : <ContextCardProvider>{card}</ContextCardProvider>;
}
