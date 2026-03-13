'use client';

import { AlertCircle, Copy } from 'lucide-react';
import { useToast } from '../../lib/toast';

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
 * Renders an error with a `stack` field as a visually distinct error block.
 * Shows the error message with an alert icon at the top, separated from
 * the stack trace below.
 */
export function ErrorStackBlock({
  value,
}: {
  value: Record<string, unknown> & { stack: string };
}) {
  const toast = useToast();
  const stack = value.stack;
  const message = typeof value.message === 'string' ? value.message : undefined;
  const copyText = message ? `${message}\n\n${stack}` : stack;

  return (
    <div
      className="relative overflow-hidden rounded-md border"
      style={{
        borderColor: 'var(--ds-red-400)',
        background: 'var(--ds-red-100)',
      }}
    >
      <button
        type="button"
        aria-label="Copy error"
        title="Copy"
        className="!absolute !right-2 !top-2 !flex !h-6 !w-6 !items-center !justify-center !rounded-md !border transition-transform transition-colors duration-100 hover:!bg-[var(--ds-red-200)] active:!scale-95"
        style={{
          borderColor: 'var(--ds-red-400)',
          background: 'var(--ds-red-100)',
          color: 'var(--ds-red-900)',
        }}
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
        <div
          className="flex items-start gap-2 px-3 py-2.5 pr-10"
          style={{
            color: 'var(--ds-red-900)',
            borderBottom: '1px solid var(--ds-red-400)',
          }}
        >
          <AlertCircle className="h-4 w-4 shrink-0" style={{ marginTop: 1 }} />
          <p className="text-xs font-semibold m-0 break-words">{message}</p>
        </div>
      )}
      <pre
        className="px-3 py-2.5 text-xs font-mono whitespace-pre-wrap break-words overflow-auto m-0"
        style={{
          color: 'var(--ds-red-900)',
          background: 'var(--ds-red-200)',
        }}
      >
        {stack}
      </pre>
    </div>
  );
}
