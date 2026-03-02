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
        className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-xs hover:brightness-95 ${summaryClassName ?? ''}`}
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-gray-100)',
          color: 'var(--ds-gray-900)',
        }}
      >
        {summary}
      </summary>
      {/* Expanded content with connecting line */}
      <div className={`relative pl-6 mt-3 ${contentClassName ?? ''}`}>
        {/* Curved connecting line - vertical part from summary */}
        <div
          className="absolute left-3 -top-3 w-px h-3"
          style={{ backgroundColor: 'var(--ds-gray-400)' }}
        />
        {/* Curved corner */}
        <div
          className="absolute left-3 top-0 w-3 h-3 border-l border-b rounded-bl-lg"
          style={{ borderColor: 'var(--ds-gray-400)' }}
        />
        {/* Horizontal part to content */}
        <div
          className="absolute left-6 top-3 w-0 h-px -translate-y-px"
          style={{ backgroundColor: 'var(--ds-gray-400)' }}
        />
        <div>{children}</div>
      </div>
    </details>
  );
}
