'use client';

import { InfoIcon } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { WorldConfig } from '@/lib/config-world';

interface ConnectionStatusProps {
  config: WorldConfig;
}

const getConnectionInfo = (
  backend: string,
  config: WorldConfig
): { provider: string; parts: string[] } => {
  if (backend === 'vercel') {
    const parts: string[] = [];
    if (config.env) parts.push(`env: ${config.env}`);
    if (config.project) parts.push(`project: ${config.project}`);
    if (config.team) parts.push(`team: ${config.team}`);

    return { provider: 'Vercel', parts };
  }

  if (backend === 'local') {
    // Local backend
    const parts: string[] = [];
    if (config.dataDir) {
      parts.push(`dir: ${config.dataDir}`);
    }
    if (config.port) parts.push(`port: ${config.port}`);

    return { provider: 'Local', parts };
  }

  return { provider: config.backend || 'unknown', parts: [] };
};

export function ConnectionStatus({ config }: ConnectionStatusProps) {
  const backend = config.backend || 'local';
  const { provider, parts } = getConnectionInfo(backend, config);

  return (
    <div className="text-sm text-muted-foreground flex items-center gap-2">
      <span className="font-medium">Connected to: {provider}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <InfoIcon className="w-4 h-4" />
        </TooltipTrigger>
        <TooltipContent>
          <div className="flex flex-col gap-1">
            {parts.map((part) => (
              <span key={part}>{part}</span>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
