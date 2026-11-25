'use client';

import { OctagonAlert } from 'lucide-react';
import { CopyButton } from './copy-button';

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
 * Workflow's structured error messages are multi-line: the first line is
 * the headline (`Failed to serialize step return value`) and the rest are
 * `╰▶ hint:` / `╰▶ docs:` framed details. The full message belongs in the
 * body of the error block; the title should be the headline so the
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
    <div className="relative overflow-hidden rounded-md border border-red-100 bg-red-200">
      <CopyButton
        textToCopy={copyText}
        aria-label="Copy error"
        className="absolute right-1 top-1 border border-red-400 text-red-900 enabled:hover:bg-red-300 enabled:hover:text-red-900 focus-visible:text-red-900"
      />

      {title && (
        <div className="flex items-center gap-3 min-h-(--ds-size-small) px-2 py-1.5 pr-10 border-b border-red-400 text-red-900">
          <OctagonAlert className="size-3.5 shrink-0" />
          {/* The full message or stack is in the body below; the header
              shows the first line, ellipsised so a long title doesn't push
              the copy button or wrap into the framed hint/docs lines. */}
          <p className="text-copy-13 font-semibold m-0 truncate">{title}</p>
        </div>
      )}
      {body && (
        <pre className="px-2 py-2.5 bg-red-300 text-red-1000 text-label-12-mono whitespace-pre-wrap break-words overflow-auto m-0">
          {body}
        </pre>
      )}
    </div>
  );
}
