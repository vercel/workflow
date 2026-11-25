import {
  TimestampTooltip,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workflow/web-shared';
import { formatDistanceToNowStrict, formatRelative } from 'date-fns';
import { useEffect, useState } from 'react';

interface RelativeTimeProps {
  date: Date | string;
  className?: string;
  type?: 'relative' | 'distance';
  /**
   * What hovering shows: a tooltip with the local time under a dotted
   * underline, or the relative time card (how long ago, in UTC and local
   * time) with no underline.
   */
  hover?: 'tooltip' | 'card';
}

export function RelativeTime({
  date,
  className = '',
  type = 'relative',
  hover = 'tooltip',
}: RelativeTimeProps) {
  const [, setNow] = useState(Date.now());
  if (typeof date === 'string') {
    date = new Date(date);
  }
  const relativeTime =
    type === 'relative'
      ? formatRelative(new Date(date), new Date())
      : formatDistanceToNowStrict(new Date(date), { addSuffix: true });

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  if (hover === 'card') {
    return (
      <TimestampTooltip date={date} side="bottom">
        <span className={className}>{relativeTime}</span>
      </TimestampTooltip>
    );
  }

  const absoluteTime = new Date(date).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`${className} cursor-help border-b border-dotted`}>
          {relativeTime}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{absoluteTime}</p>
      </TooltipContent>
    </Tooltip>
  );
}
