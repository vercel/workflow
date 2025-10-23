import { LIVE_UPDATE_INTERVAL_MS } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface LiveStatusProps {
  hasError: boolean;
  errorMessage: string;
}

export function LiveStatus({ hasError, errorMessage }: LiveStatusProps) {
  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                hasError ? 'bg-red-500' : 'bg-green-500 animate-pulse'
              }`}
            />
            <span
              className={`text-xs $
                      hasError
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-muted-foreground'`}
            >
              {hasError ? 'Error' : 'Live'}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {hasError
              ? `Error updating data: ${errorMessage}`
              : `Content updates every ${LIVE_UPDATE_INTERVAL_MS / 1000} seconds`}
          </p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
