import { XCircle } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '../ui/button';

interface CancelButtonProps {
  canCancel: boolean;
  cancelling: boolean;
  cancelDisabledReason: string | null;
  onCancel: () => void;
}

export function CancelButton({
  canCancel,
  cancelling,
  cancelDisabledReason,
  onCancel,
}: CancelButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={!canCancel || cancelling}
          >
            <XCircle className="h-4 w-4" />
            {cancelling ? 'Cancelling...' : 'Cancel'}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {cancelDisabledReason ? (
          <p>{cancelDisabledReason}</p>
        ) : (
          <p>
            This will set the run state to "cancelled", prevent further steps
            from being scheduled, and disable active hooks. Active steps will
            continue to run until they complete.
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
