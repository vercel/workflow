import type { ReactNode } from 'react';

export function DetailCard({
  summary,
  children,
}: {
  summary: ReactNode;
  children?: ReactNode;
}) {
  return (
    <details className="group">
      <summary
        className="cursor-pointer rounded-md border px-2.5 py-1.5 text-xs hover:brightness-95"
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-gray-100)',
          color: 'var(--ds-gray-900)',
        }}
      >
        {summary}
      </summary>
      {/* Expanded content with connecting line */}
      <div className="relative pl-6 mt-3">
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
