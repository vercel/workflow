'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------
// Time formatting helpers
// ---------------------------------------------------------------------------

interface TimeUnit {
  unit: string;
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

function useTimeAgo(date: number): string {
  const [timeAgo, setTimeAgo] = useState<string>('');

  useEffect(() => {
    const update = (): void => {
      const diff = Date.now() - date;
      const formatted = formatTimeDifference(diff);
      setTimeAgo(formatted ? `${formatted} ago` : 'Just now');
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [date]);

  return timeAgo;
}

// ---------------------------------------------------------------------------
// Timezone row
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
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 16,
            padding: '0 6px',
            backgroundColor: 'var(--ds-gray-200)',
            borderRadius: 3,
            fontSize: 11,
            fontFamily: 'var(--font-mono, monospace)',
            fontWeight: 500,
            color: 'var(--ds-gray-900)',
            whiteSpace: 'nowrap',
          }}
        >
          {formattedZone}
        </div>
        <span
          style={{
            fontSize: 13,
            color: 'var(--ds-gray-1000)',
            whiteSpace: 'nowrap',
          }}
        >
          {formattedDate}
        </span>
      </div>
      <span
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono, monospace)',
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--ds-gray-900)',
          whiteSpace: 'nowrap',
        }}
      >
        {formattedTime}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltip card content
// ---------------------------------------------------------------------------

function TimestampTooltipContent({ date }: { date: number }): ReactNode {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeAgo = useTimeAgo(date);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minWidth: 300,
        padding: '12px 14px',
      }}
    >
      <span
        style={{
          fontSize: 13,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--ds-gray-900)',
        }}
      >
        {timeAgo}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ZoneDateTimeRow date={date} zone="UTC" />
        <ZoneDateTimeRow date={date} zone={localTimezone} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hover tooltip wrapper
// ---------------------------------------------------------------------------

const TOOLTIP_WIDTH = 330;
const VIEWPORT_PAD = 8;

function TooltipPortal({
  triggerRect,
  onMouseEnter,
  onMouseLeave,
  date,
}: {
  triggerRect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  date: number;
}): ReactNode {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    zIndex: 9999,
    visibility: 'hidden',
  });

  useEffect(() => {
    const placement = triggerRect.top > 240 ? 'above' : 'below';
    const centerX = triggerRect.left + triggerRect.width / 2;

    const el = tooltipRef.current;
    const w = el ? el.offsetWidth : TOOLTIP_WIDTH;
    const h = el ? el.offsetHeight : 100;

    let left = centerX - w / 2;
    left = Math.max(
      VIEWPORT_PAD,
      Math.min(left, window.innerWidth - w - VIEWPORT_PAD)
    );

    let top: number;
    if (placement === 'above') {
      top = triggerRect.top - h - 6;
      if (top < VIEWPORT_PAD) {
        top = triggerRect.bottom + 6;
      }
    } else {
      top = triggerRect.bottom + 6;
      if (top + h > window.innerHeight - VIEWPORT_PAD) {
        top = triggerRect.top - h - 6;
      }
    }

    setStyle({
      position: 'fixed',
      left,
      top,
      zIndex: 9999,
      borderRadius: 10,
      border: '1px solid var(--ds-gray-alpha-200)',
      backgroundColor: 'var(--ds-background-100)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06)',
      visibility: 'visible',
    });
  }, [triggerRect]);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: tooltip hover zone
    <div
      ref={tooltipRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={style}
    >
      <TimestampTooltipContent date={date} />
    </div>,
    document.body
  );
}

export function TimestampTooltip({
  date,
  children,
}: {
  date: number | Date | string | null | undefined;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const ts =
    date == null
      ? null
      : typeof date === 'number'
        ? date
        : new Date(date).getTime();

  if (ts == null || Number.isNaN(ts)) return <>{children}</>;

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  const handleOpen = () => {
    cancelClose();
    if (triggerRef.current) {
      setTriggerRect(triggerRef.current.getBoundingClientRect());
    }
    setOpen(true);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: tooltip trigger
    <span
      ref={triggerRef}
      onMouseEnter={handleOpen}
      onMouseLeave={scheduleClose}
      style={{ display: 'inline-flex' }}
    >
      {children}
      {open && triggerRect && (
        <TooltipPortal
          triggerRect={triggerRect}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          date={ts}
        />
      )}
    </span>
  );
}
