import {
  STATUS_DOT,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@workflow/web-shared';
import { LIVE_UPDATE_INTERVAL_MS } from '~/lib/utils';

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
                hasError
                  ? STATUS_DOT.failed
                  : `${STATUS_DOT.running} animate-pulse`
              }`}
            />
            <span
              className={`text-xs ${
                hasError ? 'text-red-800' : 'text-muted-foreground'
              }`}
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
