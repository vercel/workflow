'use client';

import { InfoIcon } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useServerConfig } from '@/lib/world-config-context';

/**
 * Displays the current world connection status.
 *
 * This component shows information from the public server configuration.
 * Env-derived values are strictly allowlisted per world backend.
 */
export function ConnectionStatus() {
  const { serverConfig } = useServerConfig();
  const { backendDisplayName, backendId, publicEnv } = serverConfig;

  // Build display parts from the public config
  const parts: string[] = [];

  if (backendId === 'vercel' || backendId === '@workflow/world-vercel') {
    if (publicEnv.kind === 'vercel') {
      if (publicEnv.environment) {
        parts.push(`environment: ${publicEnv.environment}`);
      }
      if (publicEnv.projectId) parts.push(`project: ${publicEnv.projectId}`);
      if (publicEnv.teamId) parts.push(`team: ${publicEnv.teamId}`);
    }
  } else if (backendId === 'local' || backendId === '@workflow/world-local') {
    if (publicEnv.kind === 'local') {
      if (publicEnv.port) parts.push(`port: ${publicEnv.port}`);
      if (publicEnv.dataDirPath) {
        parts.push(`dataDir: ${publicEnv.dataDirPath}`);
      }
      parts.push(`projectDir: ${publicEnv.projectDir}`);
    }
  }

  // Format display string based on backend type
  let displayString: string;
  if (backendId === 'local' || backendId === '@workflow/world-local') {
    const localLabel =
      publicEnv.kind === 'local' ? publicEnv.shortName : 'Unknown';
    displayString = `Local Dev: ${localLabel}`;
  } else if (backendId === 'vercel' || backendId === '@workflow/world-vercel') {
    const vercelInfo =
      publicEnv.kind === 'vercel'
        ? publicEnv.teamId && publicEnv.projectId
          ? `${publicEnv.teamId}/${publicEnv.projectId}`
          : publicEnv.projectId ||
            publicEnv.teamId ||
            publicEnv.environment ||
            'Unknown'
        : 'Unknown';
    displayString = `Connected to Vercel (${vercelInfo})`;
  } else if (
    backendId === '@workflow/world-postgres' ||
    backendId === 'postgres'
  ) {
    displayString = 'Connected to Postgres';
  } else {
    // Fallback for other backends
    displayString = `Connected to: ${backendDisplayName}`;
  }

  const showLocalMisconfigWarning =
    (backendId === 'local' || backendId === '@workflow/world-local') &&
    publicEnv.kind === 'local' &&
    publicEnv.shortName === 'packages/web';

  return (
    <div className="text-sm text-muted-foreground flex items-center gap-2">
      <span className="font-medium">{displayString}</span>
      {(parts.length > 0 || showLocalMisconfigWarning) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <InfoIcon className="w-4 h-4 cursor-help" />
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col gap-1 max-w-[520px]">
              {showLocalMisconfigWarning && (
                <div className="mb-2">
                  <div className="font-medium text-foreground">
                    Local data directory looks misconfigured
                  </div>
                  <div className="text-muted-foreground">
                    This UI appears to be pointing at <code>packages/web</code>.
                    Configure the local data directory / working directory and
                    restart the web UI. See{' '}
                    <a
                      className="underline"
                      href="https://useworkflow.dev/docs/observability"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      docs
                    </a>
                    .
                  </div>
                </div>
              )}
              {parts.map((part) => (
                <span key={part}>{part}</span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
