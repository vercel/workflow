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

  // Determine subtitle for display
  let subString: string | undefined;
  if (backendId === 'vercel' || backendId === '@workflow/world-vercel') {
    subString = displayInfo.environment;
  } else if (backendId === 'local' || backendId === '@workflow/world-local') {
    subString = displayInfo.dataDir;
  } else if (
    backendId === '@workflow/world-postgres' ||
    backendId === 'postgres'
  ) {
    subString = displayInfo.hostname;
  }

  return (
    <div className="text-sm text-muted-foreground flex items-center gap-2">
      <span className="font-medium">
        Connected to: {backendDisplayName} {subString ? `(${subString})` : ''}
      </span>
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
