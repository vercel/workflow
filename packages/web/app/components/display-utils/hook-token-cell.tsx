import { Check, Copy, Loader2 } from 'lucide-react';
import { useState } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip';
import type { EnvMap } from '~/lib/types';
import { fetchHookToken } from '~/lib/workflow-api-client';

interface HookTokenCellProps {
  env: EnvMap;
  runId: string;
  hookId: string;
}

/**
 * Renders a hook's secret token as a masked, copy-on-demand cell.
 *
 * The token is not present in hook list rows — it is fetched one hook at a
 * time (via `fetchHookToken`) only when the user clicks to copy it. This keeps
 * the secret out of bulk list responses while preserving the copy affordance.
 */
export function HookTokenCell({ env, runId, hookId }: HookTokenCellProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'copied'>('idle');
  const [error, setError] = useState<string | null>(null);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status === 'loading') return;
    setStatus('loading');
    setError(null);
    try {
      const token = await fetchHookToken(env, runId, hookId);
      await navigator.clipboard.writeText(token);
      setStatus('copied');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to copy hook token:', err);
      setError('Failed to copy token');
      setStatus('idle');
    }
  };

  const tooltip = error
    ? error
    : status === 'copied'
      ? 'Copied!'
      : status === 'loading'
        ? 'Fetching token…'
        : 'Copy token';

  return (
    <span className="relative group/copy inline-block">
      <span className="text-muted-foreground">••••••••••••</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCopy}
            disabled={status === 'loading'}
            className="absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/copy:opacity-100 transition-opacity bg-background/80 backdrop-blur-sm p-1 rounded"
            aria-label="Copy token"
          >
            {status === 'loading' ? (
              <Loader2 className="h-3 w-3 text-muted-foreground animate-spin" />
            ) : status === 'copied' ? (
              <Check className="h-3 w-3 text-muted-foreground" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
