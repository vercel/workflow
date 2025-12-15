import { RotateCw } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '../ui/button';

interface RerunButtonProps {
  canRerun: boolean;
  rerunning: boolean;
  rerunDisabledReason: string | null;
  onRerun: () => void;
}

export function RerunButton({
  canRerun,
  rerunning,
  rerunDisabledReason,
  onRerun,
}: RerunButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            variant="outline"
            size="sm"
            onClick={onRerun}
            disabled={!canRerun || rerunning}
          >
            <RotateCw className="h-4 w-4" />
            {rerunning ? 'Replaying...' : 'Replay'}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {rerunDisabledReason ? (
          <p>{rerunDisabledReason}</p>
        ) : (
          <p>
            This will start a new copy of the current run using the same
            deployment, environment, and inputs. It will not affect the current
            run.
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
