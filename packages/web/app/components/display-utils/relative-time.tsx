import {
  formatRelativeTime,
  formatTimestamp,
  parseDateValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workflow/web-shared';
import { useEffect, useState } from 'react';

interface RelativeTimeProps {
  date: Date | string;
  className?: string;
}

export function RelativeTime({ date, className = '' }: RelativeTimeProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const parsed = parseDateValue(date);
  if (!parsed) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`${className} cursor-help border-b border-dotted`}>
          {formatRelativeTime(parsed, { now })}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{formatTimestamp(parsed)}</p>
      </TooltipContent>
    </Tooltip>
  );
}
