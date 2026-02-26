'use client';

import { Copy } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Check whether `value` looks like a structured error object with a `stack`
 * field that we can render as pre-formatted text.
 */
export function isStructuredErrorWithStack(
  value: unknown
): value is Record<string, unknown> & { stack: string } {
  return (
    value != null &&
    typeof value === 'object' &&
    'stack' in value &&
    typeof (value as Record<string, unknown>).stack === 'string'
  );
}

/**
 * Renders an error with a `stack` field as readable pre-formatted text,
 * styled to match the CopyableDataBlock component. The error message is
 * displayed at the top with a visual separator from the stack trace.
 * The entire block is copyable via a copy button.
 */
export function ErrorStackBlock({
  value,
}: {
  value: Record<string, unknown> & { stack: string };
}) {
  const stack = value.stack;
  const message = typeof value.message === 'string' ? value.message : undefined;
  const copyText = message ? `${message}\n\n${stack}` : stack;

  return (
    <div
      className="relative overflow-x-auto rounded-md border p-3 pt-9"
      style={{ borderColor: 'var(--ds-gray-300)' }}
    >
      <button
        type="button"
        aria-label="Copy error"
        title="Copy"
        className="!absolute !right-2 !top-2 !flex !h-6 !w-6 !items-center !justify-center !rounded-md !border !bg-[var(--ds-background-100)] !text-[var(--ds-gray-800)] transition-transform transition-colors duration-100 hover:!bg-[var(--ds-gray-alpha-200)] active:!scale-95 active:!bg-[var(--ds-gray-alpha-300)]"
        style={{ borderColor: 'var(--ds-gray-300)' }}
        onClick={() => {
          navigator.clipboard
            .writeText(copyText)
            .then(() => {
              toast.success('Copied to clipboard');
            })
            .catch(() => {
              toast.error('Failed to copy');
            });
        }}
      >
        <Copy size={12} />
      </button>

      {message && (
        <p
          className="pb-2 mb-2 text-xs font-semibold font-mono"
          style={{
            color: 'var(--ds-red-900)',
            borderBottom: '1px solid var(--ds-gray-300)',
          }}
        >
          {message}
        </p>
      )}
      <pre
        className="text-xs font-mono whitespace-pre-wrap break-words overflow-auto m-0"
        style={{ color: 'var(--ds-gray-1000)' }}
      >
        {stack}
      </pre>
    </div>
  );
}
