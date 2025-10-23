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
      {cancelDisabledReason && (
        <TooltipContent>
          <p>{cancelDisabledReason}</p>
        </TooltipContent>
      )}
    </Tooltip>
  );
}
