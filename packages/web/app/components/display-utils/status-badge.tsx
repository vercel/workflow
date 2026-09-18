import type { Step, WorkflowRun } from '@workflow/world';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip';
import { getStatusColorClass } from '~/lib/status-colors';
import { cn, formatDuration } from '~/lib/utils';

/** Extract the error code from an unknown error value (StructuredError shape). */
function getErrorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

interface StatusBadgeProps {
  status: WorkflowRun['status'] | Step['status'];
  context?: { error?: unknown; cancelReason?: string };
  className?: string;
  /** Duration in milliseconds to display below status */
  durationMs?: number;
}

export function StatusBadge({
  status,
  context,
  className,
  durationMs,
}: StatusBadgeProps) {
  const content = (
    <span className={cn('flex flex-row gap-2', className)}>
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            'size-2 rounded-full shrink-0',
            getStatusColorClass(status)
          )}
        />
        <span className="text-muted-foreground text-xs font-medium capitalize">
          {status}
        </span>
      </span>
      {durationMs !== undefined && (
        <span className="text-muted-foreground/70 text-xs">
          ({formatDuration(durationMs)})
        </span>
      )}
    </span>
  );

  // Show error code tooltip if status is failed and error has a code
  const errorCode =
    status === 'failed' ? getErrorCode(context?.error) : undefined;
  if (errorCode) {
    return <ErrorCodeBadge content={content} errorCode={errorCode} />;
  }

  const cancelReason = context?.cancelReason?.trim();
  if (status === 'cancelled' && cancelReason) {
    return (
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="cursor-help appearance-none border-0 bg-transparent p-0 text-left"
          >
            {content}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs whitespace-pre-wrap break-words">
          {cancelReason}
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

function ErrorCodeBadge({
  content,
  errorCode,
}: {
  content: React.ReactNode;
  errorCode: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(errorCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail on unfocused pages or non-HTTPS contexts
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{content}</span>
      </TooltipTrigger>
      <TooltipContent className="p-0">
        <div className="flex items-center gap-2 p-1.5">
          <span className="text-xs font-mono">{errorCode}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-2.5 w-2.5 text-muted-foreground" />
            ) : (
              <Copy className="h-2.5 w-2.5 text-muted-foreground" />
            )}
          </Button>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
