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
            {rerunning ? 'Re-running...' : 'Re-run'}
          </Button>
        </span>
      </TooltipTrigger>
      {rerunDisabledReason && (
        <TooltipContent>
          <p>{rerunDisabledReason}</p>
        </TooltipContent>
      )}
    </Tooltip>
  );
}
