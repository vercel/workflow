import { Activity, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip';
import { runHealthCheck } from '~/lib/rpc-client';
import type { EnvMap } from '~/lib/types';

export function HealthCheckButton() {
  const [isChecking, setIsChecking] = useState(false);
  const env: EnvMap = useMemo(() => ({}), []);

  const runChecks = useCallback(async () => {
    setIsChecking(true);

    try {
      const response = await runHealthCheck(env, { timeout: 30000 });
      if (!response.success) {
        throw new Error(response.error.message);
      }

      if (response.data.healthy) {
        toast.success('Workflow endpoint healthy', {
          description: `The queue-based check completed in ${response.data.latencyMs ?? 0}ms.`,
        });
      } else {
        toast.error('Health check failed', {
          description: response.data.error || 'Workflow endpoint is unhealthy.',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Health check error', {
        description: message,
      });
    } finally {
      setIsChecking(false);
    }
  }, [env]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={runChecks}
          disabled={isChecking}
          className="gap-1.5"
        >
          {isChecking ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Activity className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">
            {isChecking ? 'Checking...' : 'Health Check'}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>
          Run a queue-based health check on the workflow endpoint.
          <br />
          This bypasses Deployment Protection.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
