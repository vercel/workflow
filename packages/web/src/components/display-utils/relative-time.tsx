'use client';

import { formatDistanceToNowStrict, formatRelative } from 'date-fns';
import { useEffect, useState } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface RelativeTimeProps {
  date: Date | string;
  className?: string;
  type?: 'relative' | 'distance';
}

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
  const absoluteTime = new Date(date).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

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
