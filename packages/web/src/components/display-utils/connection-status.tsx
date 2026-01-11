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
 * This component shows information from the server configuration,
 * which never includes sensitive data like connection strings or auth tokens.
 */
export function ConnectionStatus() {
  const { serverConfig } = useServerConfig();
  const { backendDisplayName, backendId, displayInfo } = serverConfig;

  // Build display parts from the server config
  const parts: string[] = [];

  if (backendId === 'vercel' || backendId === '@workflow/world-vercel') {
    if (displayInfo.environment) {
      parts.push(`environment: ${displayInfo.environment}`);
    }
    if (displayInfo.projectName) {
      parts.push(`project: ${displayInfo.projectName}`);
    }
    if (displayInfo.teamName) {
      parts.push(`team: ${displayInfo.teamName}`);
    }
  } else if (
    backendId === '@workflow/world-postgres' ||
    backendId === 'postgres'
  ) {
    if (displayInfo.hostname) {
      parts.push(`host: ${displayInfo.hostname}`);
    }
    if (displayInfo.database) {
      parts.push(`database: ${displayInfo.database}`);
    }
  } else if (backendId === 'local' || backendId === '@workflow/world-local') {
    if (displayInfo.dataDir) {
      parts.push(`data: ${displayInfo.dataDir}`);
    }
  }

  // Format display string based on backend type
  let displayString: string;
  if (backendId === 'local' || backendId === '@workflow/world-local') {
    displayString = `Local Dev: ${displayInfo.projectShortName || displayInfo.dataDir || 'Unknown'}`;
  } else if (backendId === 'vercel' || backendId === '@workflow/world-vercel') {
    const vercelInfo =
      displayInfo.teamName && displayInfo.projectName
        ? `${displayInfo.teamName}/${displayInfo.projectName}`
        : displayInfo.projectName ||
          displayInfo.teamName ||
          displayInfo.environment ||
          'Unknown';
    displayString = `Connected to Vercel (${vercelInfo})`;
  } else if (
    backendId === '@workflow/world-postgres' ||
    backendId === 'postgres'
  ) {
    const postgresInfo =
      displayInfo.hostname || displayInfo.database || 'Unknown';
    displayString = `Connected to Postgres (${postgresInfo})`;
  } else {
    // Fallback for other backends
    displayString = `Connected to: ${backendDisplayName}`;
  }

  return (
    <div className="text-sm text-muted-foreground flex items-center gap-2">
      <span className="font-medium">{displayString}</span>
      {parts.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <InfoIcon className="w-4 h-4 cursor-help" />
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col gap-1">
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
