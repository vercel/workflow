'use client';

import { CopyButton } from '../trace-viewer/components/copy-button';
import { Note, NoteContent } from './note';

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
 * Renders a structured error as an error `Note`: the message headline at the
 * top and the stack trace or full message below.
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
    <Note variant="error">
      <CopyButton
        copyText={copyText}
        ariaLabel="Copy error"
        className="absolute right-2 top-1.5 flex h-6 w-6 items-center justify-center rounded-[6px] border border-red-400 bg-red-100 p-0 text-red-900 transition-transform transition-colors duration-100 hover:bg-red-200 active:scale-95"
      />
      {title && (
        <NoteContent
          className="truncate pr-7 font-semibold"
          // The full message or stack is in the body below; the header
          // shows the first line, single-line, with overflow ellipsised so
          // a long title doesn't wrap into the framed hint/docs lines.
          title={message}
        >
          {title}
        </NoteContent>
      )}
      {body && (
        <pre className="m-0 overflow-auto whitespace-pre-wrap break-words rounded-[4px] bg-red-100 p-3 text-label-12-mono">
          {body}
        </pre>
      )}
    </Note>
  );
}
