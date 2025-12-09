import { AlarmClockOff } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '../ui/button';

interface StopSleepButtonProps {
  canStopSleep: boolean;
  stoppingSleep: boolean;
  stopSleepDisabledReason: string | null;
  onStopSleep: () => void;
}

export function StopSleepButton({
  canStopSleep,
  stoppingSleep,
  stopSleepDisabledReason,
  onStopSleep,
}: StopSleepButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            variant="outline"
            size="sm"
            onClick={onStopSleep}
            disabled={!canStopSleep || stoppingSleep}
          >
            <AlarmClockOff className="h-4 w-4" />
            {stoppingSleep ? 'Stopping...' : 'Stop sleep'}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {stopSleepDisabledReason ? (
          <p>{stopSleepDisabledReason}</p>
        ) : (
          <p>
            Interrupt any current calls to <code>sleep</code> and wake up the
            run.
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
