'use client';

import type { Step, WorkflowRun } from '@workflow/world';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface StatusBadgeProps {
  status: WorkflowRun['status'] | Step['status'];
  context?: { error?: unknown };
  className?: string;
}

export function StatusBadge({ status, context, className }: StatusBadgeProps) {
  const getStatusClasses = () => {
    switch (status) {
      case 'running':
        return 'text-blue-600 dark:text-blue-400';
      case 'completed':
        return 'text-green-600 dark:text-green-400';
      case 'failed':
        return 'text-red-600 dark:text-red-400';
      case 'cancelled':
        return 'text-yellow-600 dark:text-yellow-400';
      case 'pending':
        return 'text-gray-600 dark:text-gray-400';
      case 'paused':
        return 'text-orange-600 dark:text-orange-400';
      default:
        return 'text-gray-500 dark:text-gray-400';
    }
  };

  // Show error tooltip if status is failed and error exists
  if (status === 'failed' && context?.error) {
    const errorMessage =
      typeof context.error === 'string'
        ? context.error
        : context.error instanceof Error
          ? context.error.message
          : JSON.stringify(context.error);

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`${className} border-b border-dotted cursor-help ${getStatusClasses()}`}
          >
            {status}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-md">
          <p className="text-xs whitespace-pre-wrap break-words">
            {errorMessage}
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return <span className={`${className} ${getStatusClasses()}`}>{status}</span>;
}
