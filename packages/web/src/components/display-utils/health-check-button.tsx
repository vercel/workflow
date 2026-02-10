'use client';

import { Activity, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type {
  HealthCheckEndpoint,
  HealthCheckResult,
} from '@workflow/core/runtime/helpers';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { type EnvMap, runHealthCheck } from '@/server/workflow-server-actions';

interface EndpointResult {
  endpoint: HealthCheckEndpoint;
  result: HealthCheckResult;
}

export function HealthCheckButton() {
  const [isChecking, setIsChecking] = useState(false);
  const env: EnvMap = useMemo(() => ({}), []);

  const runChecks = useCallback(async () => {
    setIsChecking(true);

    const endpoints: HealthCheckEndpoint[] = ['workflow', 'step'];
    const results: EndpointResult[] = [];

    try {
      for (const endpoint of endpoints) {
        const response = await runHealthCheck(env, endpoint, {
          timeout: 30000,
        });
        // runHealthCheck always returns success: true, with healthy: false on errors
        // but we still need the check for TypeScript type narrowing
        if (response.success) {
          results.push({ endpoint, result: response.data });
        }
      }

      const allHealthy = results.every((r) => r.result.healthy);
      const anyHealthy = results.some((r) => r.result.healthy);

      if (allHealthy) {
        const totalLatency = results.reduce(
          (sum, r) => sum + (r.result.latencyMs ?? 0),
          0
        );
        toast.success('All endpoints healthy', {
          description: `Workflow and Step endpoints are responding (${totalLatency}ms total)`,
        });
      } else if (anyHealthy) {
        const healthy = results.filter((r) => r.result.healthy);
        const unhealthy = results.filter((r) => !r.result.healthy);
        toast.warning('Partial health check success', {
          description: `${healthy.map((r) => r.endpoint).join(', ')} OK; ${unhealthy.map((r) => `${r.endpoint}: ${r.result.error || 'failed'}`).join(', ')}`,
        });
      } else {
        const errors = results
          .map((r) => `${r.endpoint}: ${r.result.error || 'failed'}`)
          .join('; ');
        toast.error('Health check failed', {
          description: errors,
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
          Run a queue-based health check on workflow and step endpoints.
          <br />
          This bypasses Deployment Protection.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
