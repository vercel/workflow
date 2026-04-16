import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

export function DetailCard({
  summary,
  children,
  onToggle,
  disabled = false,
  summaryClassName,
  contentClassName,
}: {
  summary: ReactNode;
  children?: ReactNode;
  /** Called when the detail card is expanded/collapsed */
  onToggle?: (open: boolean) => void;
  /** Renders a non-expandable summary card when true. */
  disabled?: boolean;
  /** Extra classes for the summary row. */
  summaryClassName?: string;
  /** Extra classes for expanded content wrapper. */
  contentClassName?: string;
}) {
  if (disabled) {
    return (
      <div
        className={`rounded-md border px-2.5 py-1.5 text-xs ${summaryClassName ?? ''}`}
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-gray-100)',
          color: 'var(--ds-gray-700)',
          cursor: 'not-allowed',
          opacity: 0.8,
        }}
      >
        {summary}
      </div>
    );
  }

  return (
    <details
      className="group"
      onToggle={(e) => onToggle?.((e.target as HTMLDetailsElement).open)}
    >
      <summary
        className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-xs hover:brightness-95 [&::-webkit-details-marker]:hidden ${summaryClassName ?? ''}`}
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-gray-100)',
          color: 'var(--ds-gray-900)',
          listStyle: 'none',
        }}
      >
        <span className="flex items-center gap-1.5">
          <ChevronRight
            size={14}
            className="shrink-0 transition-transform group-open:rotate-90"
          />
          {summary}
        </span>
      </summary>
      <div className={`mt-2 ${contentClassName ?? ''}`}>{children}</div>
    </details>
  );
}
