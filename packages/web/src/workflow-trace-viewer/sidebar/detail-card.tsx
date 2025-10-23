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
        className="cursor-pointer rounded-md border px-3 py-2 text-copy-14 hover:brightness-95"
        style={{
          borderColor: 'var(--ds-gray-300)',
          backgroundColor: 'var(--ds-gray-100)',
          color: 'var(--ds-gray-900)',
        }}
      >
        {summary}
      </summary>
      <div className="p-2">{children}</div>
    </details>
  );
}
