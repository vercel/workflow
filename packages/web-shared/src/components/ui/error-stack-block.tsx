'use client';

import { AlertCircle } from 'lucide-react';
import { CopyButton } from '../new-trace-viewer/components/copy-button';

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
 * Pull a short, single-line title out of an error message.
 *
 * Workflow's structured error messages are multi-line — the first line is
 * the headline (`Failed to serialize step return value`) and the rest are
 * `╰▶ hint:` / `╰▶ docs:` framed details. The full message belongs in the
 * body of the error block; the title should just be the headline so the
 * card stays scannable.
 */
function deriveTitle(message: string): string {
  const firstLine =
    message.split('\n').find((line) => line.trim().length > 0) ?? message;
  return firstLine.trim();
}

/**
 * Renders a structured error as a visually distinct error block. Shows the
 * error message with an alert icon at the top, separated from the stack trace
 * or full message below.
 */
export function ErrorStackBlock({ value }: { value: StructuredErrorRecord }) {
  const stack = typeof value.stack === 'string' ? value.stack : undefined;
  const message = typeof value.message === 'string' ? value.message : undefined;
  const body = stack ?? message ?? '';
  // V8's `Error.stack` already starts with `Name: message`; message-only
  // errors use the message as the body so long single-line failures remain
  // readable even when the header truncates.
  const title = message ? deriveTitle(message) : deriveTitle(body);
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
      <CopyButton
        copyText={copyText}
        ariaLabel="Copy error"
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border border-red-400 bg-red-100 p-0 text-red-900 transition-transform transition-colors duration-100 hover:bg-red-200 active:scale-95"
      />

      {title && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 pr-10"
          style={{
            color: 'var(--ds-red-900)',
            borderBottom: '1px solid var(--ds-red-400)',
          }}
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <p
            className="text-xs font-semibold m-0 truncate"
            // The full message or stack is in the body below; the header just
            // shows the first line, single-line, with overflow
            // ellipsised so a long title doesn't push the copy button or
            // wrap into the framed hint/docs lines.
            title={message}
          >
            {title}
          </p>
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
