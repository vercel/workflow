import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../../lib/cn';

export function DetailCard({
  summary,
  children,
  onToggle,
  disabled = false,
  defaultOpen = false,
  variant = 'section',
  trailing,
  summaryClassName,
  contentClassName,
}: {
  summary: ReactNode;
  children?: ReactNode;
  onToggle?: (open: boolean) => void;
  disabled?: boolean;
  defaultOpen?: boolean;
  variant?: 'section' | 'card';
  trailing?: ReactNode;
  summaryClassName?: string;
  contentClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const handleToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    // React surfaces `toggle` as a bubbling synthetic event even though the
    // native event doesn't bubble. Without this guard, a nested <details>
    // (e.g. an event card inside the Events section) collapsing would flip
    // the outer DetailCard's state. Only react to direct toggles.
    if (e.target !== e.currentTarget) return;
    const next = e.currentTarget.open;
    setOpen(next);
    onToggle?.(next);
  };

  if (variant === 'card') {
    if (disabled) {
      return (
        <div
          className={cn(
            'list-none px-3 py-4 bg-background-200 [&::-webkit-details-marker]:hidden',
            summaryClassName
          )}
          style={{ cursor: 'not-allowed', opacity: 0.8 }}
        >
          {summary}
        </div>
      );
    }
    return (
      <details
        className="group/card last:border-b border-gray-alpha-400"
        open={open}
        onToggle={handleToggle}
      >
        <summary
          className={cn(
            'list-none cursor-pointer px-3 py-4 border-t border-gray-alpha-400 bg-background-200 hover:bg-gray-100 [&::-webkit-details-marker]:hidden',
            summaryClassName
          )}
        >
          <span className="flex items-center gap-1.5">
            <ChevronRight
              size={14}
              className={cn(
                'shrink-0 text-gray-700 group-hover/card:text-gray-1000',
                open && 'rotate-90'
              )}
            />
            {summary}
          </span>
        </summary>
        <div className={contentClassName}>{children}</div>
      </details>
    );
  }

  // Shared height with the expandable summary row. Keeps the trailing /
  // disabled / chevron variants visually identical in height regardless of
  // what's in the trailing slot.
  const rowClasses =
    'flex h-9 items-center gap-2 px-2 -mx-2 text-heading-14 font-medium my-2';

  if (trailing) {
    return (
      <section className="-mx-4 border-t px-4 border-gray-alpha-400">
        <div className={cn(rowClasses, summaryClassName)}>
          <div className="isolate relative shrink-0 w-3.5 h-3.5 text-gray-700">
            <ChevronRight
              size={14}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
            />
          </div>
          <span className="min-w-0 flex-1">{summary}</span>
          <div className="shrink-0 pr-1">{trailing}</div>
        </div>
      </section>
    );
  }

  if (disabled) {
    return (
      <section className="-mx-4 border-t px-4 border-gray-alpha-400">
        <div
          className={cn(rowClasses, summaryClassName)}
          style={{ color: 'var(--ds-gray-700)', cursor: 'not-allowed' }}
        >
          <span className="min-w-0 flex-1">{summary}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="-mx-4 border-t px-4 border-gray-alpha-400">
      <details className="group" open={open} onToggle={handleToggle}>
        <summary
          className={cn(
            'group/trigger list-none cursor-pointer rounded hover:bg-gray-alpha-100 [&::-webkit-details-marker]:hidden',
            rowClasses,
            summaryClassName
          )}
        >
          <div className="isolate relative shrink-0 text-gray-700 group-hover/trigger:text-gray-1000 w-3.5 h-3.5">
            <ChevronRight
              size={14}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-100 group-open:opacity-0"
            />
            <ChevronDown
              size={14}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-open:opacity-100"
            />
          </div>
          <span className="min-w-0 flex-1">{summary}</span>
        </summary>
        <div className={cn('mb-3', contentClassName)}>{children}</div>
      </details>
    </section>
  );
}
