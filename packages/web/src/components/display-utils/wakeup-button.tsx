import { Zap } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '../ui/button';

interface WakeUpButtonProps {
  canWakeUp: boolean;
  wakingUp: boolean;
  wakeUpDisabledReason: string | null;
  onWakeUp: () => void;
}

export function WakeUpButton({
  canWakeUp,
  wakingUp,
  wakeUpDisabledReason,
  onWakeUp,
}: WakeUpButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            variant="outline"
            size="sm"
            onClick={onWakeUp}
            disabled={!canWakeUp || wakingUp}
          >
            <Zap className="h-4 w-4" />
            {wakingUp ? 'Waking up...' : 'Wake up'}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {wakeUpDisabledReason ? (
          <p>{wakeUpDisabledReason}</p>
        ) : (
          <p>
            Re-enqueue the workflow orchestration layer. This is a no-op, unless
            the workflow got stuck due to an implementation issue in the World.
            This is useful for debugging custom Worlds.
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
