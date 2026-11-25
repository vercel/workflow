import { TimestampTooltip } from '@workflow/web-shared';
import { formatDistanceToNowStrict, formatRelative } from 'date-fns';
import { useEffect, useState } from 'react';

interface RelativeTimeProps {
  date: Date | string;
  className?: string;
  type?: 'relative' | 'distance';
}

/** A relative time; hovering it shows the relative time card. */
export function RelativeTime({
  date,
  className = '',
  type = 'relative',
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

  return (
    <TimestampTooltip date={date}>
      <span className={className}>{relativeTime}</span>
    </TimestampTooltip>
  );
}
