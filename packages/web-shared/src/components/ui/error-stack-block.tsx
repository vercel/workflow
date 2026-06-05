'use client';

import { AlertCircle, Copy } from 'lucide-react';
import { useToast } from '../../lib/toast';

export type StructuredErrorRecord = Record<string, unknown> & {
  message?: string;
  stack?: string;
};

/**
 * Check whether `value` looks like a structured error object we can render
 * with the error block. Some persisted workflow errors only include a
 * `message`, while runtime errors usually also include `stack`.
 */
export function isStructuredError(
  value: unknown
): value is StructuredErrorRecord {
  return (
    value != null &&
    typeof value === 'object' &&
    (typeof (value as Record<string, unknown>).message === 'string' ||
      typeof (value as Record<string, unknown>).stack === 'string')
  );
}

/**
 * Narrower guard kept for callers that specifically need a stack trace.
 */
export function isStructuredErrorWithStack(
  value: unknown
): value is StructuredErrorRecord & { stack: string } {
  return (
    isStructuredError(value) &&
    typeof (value as StructuredErrorRecord).stack === 'string'
  );
}

/**
 * Renders a structured error as a visually distinct error block. Shows the
 * error message with an alert icon at the top, separated from the stack trace
 * or full message below.
 */
export function ErrorStackBlock({ value }: { value: StructuredErrorRecord }) {
  const toast = useToast();
  const stack = typeof value.stack === 'string' ? value.stack : undefined;
  const message = typeof value.message === 'string' ? value.message : undefined;
  const body = stack ?? message ?? '';
  // V8's `Error.stack` already starts with `Name: message`; message-only
  // errors use the message as the body so long single-line failures remain
  // readable even when the header truncates.
  const copyText =
    message && stack && !stack.includes(message)
      ? `${message}\n\n${stack}`
      : body;

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
      {body && (
        <pre
          className="px-3 py-2.5 text-xs font-mono whitespace-pre-wrap break-words overflow-auto m-0"
          style={{
            color: 'var(--ds-red-900)',
            background: 'var(--ds-red-200)',
          }}
        >
          {body}
        </pre>
      )}
    </div>
  );
}
