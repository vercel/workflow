'use client';

import { AlertCircleIcon, CheckCircle2Icon, LoaderIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { WorldConfig } from '@/lib/config-world';

interface EndpointsHealthStatusProps {
  config: WorldConfig;
}

interface HealthCheckResult {
  flow: 'pending' | 'success' | 'error';
  step: 'pending' | 'success' | 'error';
  flowMessage?: string;
  stepMessage?: string;
  checkedAt?: string;
}

const HEALTH_CHECK_SESSION_KEY = 'workflow-endpoints-health-check';
const HEALTH_CHECK_NOT_SUPPORTED_MESSAGE =
  'Health checks not supported for this backend';

function getSessionHealthCheck(configKey: string): HealthCheckResult | null {
  try {
    const stored = sessionStorage.getItem(
      `${HEALTH_CHECK_SESSION_KEY}-${configKey}`
    );
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore sessionStorage errors (e.g., in SSR or private browsing)
  }
  return null;
}

function setSessionHealthCheck(
  configKey: string,
  result: HealthCheckResult
): void {
  try {
    sessionStorage.setItem(
      `${HEALTH_CHECK_SESSION_KEY}-${configKey}`,
      JSON.stringify(result)
    );
  } catch {
    // Ignore sessionStorage errors
  }
}

/**
 * Simple hash function for creating a unique identifier from a string.
 * Uses a basic djb2 hash algorithm to avoid exposing sensitive data in cache keys.
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function getConfigKey(config: WorldConfig): string {
  // Create a unique key based on all relevant config values that uniquely identify the backend
  // Include backend, port, and backend-specific fields
  const keyObj: Record<string, unknown> = {
    backend: config.backend || 'local',
    port: config.port || '3000',
  };

  // Add backend-specific fields
  if (config.env) keyObj.env = config.env;
  if (config.project) keyObj.project = config.project;
  if (config.team) keyObj.team = config.team;
  if (config.dataDir) keyObj.dataDir = config.dataDir;
  // Hash the postgres URL to avoid exposing credentials in session storage
  if (config.postgresUrl) {
    keyObj.postgresUrlHash = simpleHash(config.postgresUrl);
  }

  return JSON.stringify(keyObj);
}

function getBaseUrl(config: WorldConfig): string | null {
  const backend = config.backend || 'local';

  if (backend === 'local') {
    const port = config.port || '3000';
    return `http://localhost:${port}`;
  }

  // For Vercel backend, we can't perform health checks from the browser
  // as the endpoints are not accessible via HTTP
  if (backend === 'vercel') {
    return null;
  }

  // For other backends like postgres, also not directly accessible
  return null;
}

async function checkEndpointHealth(
  baseUrl: string,
  endpoint: 'flow' | 'step',
  signal?: AbortSignal
): Promise<{ success: boolean; message: string }> {
  try {
    const url = new URL(
      `/.well-known/workflow/v1/${endpoint}?__health`,
      baseUrl
    );
    const response = await fetch(url.toString(), {
      method: 'POST',
      // Use provided signal or default to 5 second timeout
      signal: signal || AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const text = await response.text();
      return { success: true, message: text };
    }
    return {
      success: false,
      message: `HTTP ${response.status}: ${response.statusText}`,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Connection failed';
    return { success: false, message };
  }
}

export function EndpointsHealthStatus({ config }: EndpointsHealthStatusProps) {
  const [healthCheck, setHealthCheck] = useState<HealthCheckResult>({
    flow: 'pending',
    step: 'pending',
  });
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    const configKey = getConfigKey(config);
    const cached = getSessionHealthCheck(configKey);

    // If we have a cached result from this session, use it
    if (cached) {
      setHealthCheck(cached);
      return;
    }

    // Determine base URL based on config
    const baseUrl = getBaseUrl(config);

    // If backend doesn't support health checks (e.g., Vercel, Postgres),
    // don't perform the check
    if (!baseUrl) {
      const result: HealthCheckResult = {
        flow: 'error',
        step: 'error',
        flowMessage: HEALTH_CHECK_NOT_SUPPORTED_MESSAGE,
        stepMessage: HEALTH_CHECK_NOT_SUPPORTED_MESSAGE,
        checkedAt: new Date().toISOString(),
      };
      setHealthCheck(result);
      setSessionHealthCheck(configKey, result);
      return;
    }

    // Otherwise, perform the health check
    const abortController = new AbortController();

    const performHealthCheck = async () => {
      setIsChecking(true);

      try {
        const [flowResult, stepResult] = await Promise.all([
          checkEndpointHealth(baseUrl, 'flow', abortController.signal),
          checkEndpointHealth(baseUrl, 'step', abortController.signal),
        ]);

        // Check if request was aborted (component unmounted)
        if (abortController.signal.aborted) {
          return;
        }

        const result: HealthCheckResult = {
          flow: flowResult.success ? 'success' : 'error',
          step: stepResult.success ? 'success' : 'error',
          flowMessage: flowResult.message,
          stepMessage: stepResult.message,
          checkedAt: new Date().toISOString(),
        };

        setHealthCheck(result);
        setSessionHealthCheck(configKey, result);
      } catch (error) {
        // If aborted, don't update state (component unmounted)
        if (abortController.signal.aborted) {
          return;
        }
        // Otherwise, log unexpected error
        console.error('Unexpected error during health check:', error);
      } finally {
        // Always reset loading state unless aborted
        if (!abortController.signal.aborted) {
          setIsChecking(false);
        }
      }
    };

    performHealthCheck();

    // Cleanup function to cancel in-flight requests
    return () => {
      abortController.abort();
    };
  }, [config]);

  const allSuccess =
    healthCheck.flow === 'success' && healthCheck.step === 'success';
  const anyError = healthCheck.flow === 'error' || healthCheck.step === 'error';
  const isPending =
    healthCheck.flow === 'pending' || healthCheck.step === 'pending';

  const getStatusIcon = () => {
    if (isChecking || isPending) {
      return (
        <LoaderIcon className="w-4 h-4 text-muted-foreground animate-spin" />
      );
    }
    if (allSuccess) {
      return <CheckCircle2Icon className="w-4 h-4 text-green-500" />;
    }
    if (anyError) {
      return <AlertCircleIcon className="w-4 h-4 text-amber-500" />;
    }
    return <LoaderIcon className="w-4 h-4 text-muted-foreground" />;
  };

  const getStatusText = () => {
    if (isChecking || isPending) {
      return 'Checking endpoints...';
    }
    if (allSuccess) {
      return 'Endpoints healthy';
    }
    if (anyError) {
      return 'Endpoint issues';
    }
    return 'Unknown status';
  };

  const getEndpointStatus = (status: 'pending' | 'success' | 'error') => {
    if (status === 'success') {
      return <CheckCircle2Icon className="w-3 h-3 text-green-500 inline" />;
    }
    if (status === 'error') {
      return <AlertCircleIcon className="w-3 h-3 text-amber-500 inline" />;
    }
    return <LoaderIcon className="w-3 h-3 text-muted-foreground inline" />;
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-default">
          {getStatusIcon()}
          <span>{getStatusText()}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex flex-col gap-2 text-xs">
          <div className="font-medium">Workflow Endpoint Health</div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {getEndpointStatus(healthCheck.flow)}
              <span className="font-mono">/.well-known/workflow/v1/flow</span>
            </div>
            {healthCheck.flowMessage && (
              <div className="text-muted-foreground pl-5 truncate">
                {healthCheck.flowMessage}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {getEndpointStatus(healthCheck.step)}
              <span className="font-mono">/.well-known/workflow/v1/step</span>
            </div>
            {healthCheck.stepMessage && (
              <div className="text-muted-foreground pl-5 truncate">
                {healthCheck.stepMessage}
              </div>
            )}
          </div>
          {healthCheck.checkedAt && (
            <div className="text-muted-foreground border-t pt-1 mt-1">
              Checked at {new Date(healthCheck.checkedAt).toLocaleTimeString()}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
