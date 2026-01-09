'use client';

import { InfoIcon, Lock } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { WorkflowDataDirInfo, WorldConfig } from '@/lib/config-world';
import { useDataDirInfo } from '@/lib/hooks';
import { useWorldConfig } from '@/lib/world-config-context';

interface ConnectionStatusProps {
  config: WorldConfig;
}

const getConnectionInfo = (
  backend: string,
  config: WorldConfig,
  dataDirInfo: WorkflowDataDirInfo | null | undefined,
  isHardcoded: boolean,
  backendDisplayName?: string
): { provider: string; parts: string[] } => {
  // In hardcoded mode, use the display name from server
  if (isHardcoded && backendDisplayName) {
    const parts: string[] = ['Configuration locked via environment variables'];
    return { provider: backendDisplayName, parts };
  }

  if (backend === 'vercel') {
    const parts: string[] = [];
    if (config.env) parts.push(`env: ${config.env}`);
    if (config.project) parts.push(`project: ${config.project}`);
    if (config.team) parts.push(`team: ${config.team}`);

    return { provider: 'Vercel', parts };
  }

  if (backend === 'local') {
    // Local backend - show projectDir instead of raw dataDir
    const parts: string[] = [];
    if (dataDirInfo?.projectDir) {
      parts.push(`project: ${dataDirInfo.projectDir}`);
    }
    if (config.port) parts.push(`port: ${config.port}`);

    return { provider: 'Local', parts };
  }

  if (backend === 'postgres') {
    const parts: string[] = [];
    if (config.postgresUrl) {
      // Only show host info, not credentials
      try {
        const url = new URL(config.postgresUrl);
        parts.push(`host: ${url.hostname}`);
        if (url.pathname && url.pathname !== '/') {
          parts.push(`database: ${url.pathname.slice(1)}`);
        }
      } catch {
        parts.push('Connection URL configured');
      }
    }
    return { provider: 'PostgreSQL', parts };
  }

  return { provider: config.backend || 'unknown', parts: [] };
};

export function ConnectionStatus({ config }: ConnectionStatusProps) {
  const { isHardcoded, backendDisplayName } = useWorldConfig();
  const backend = config.backend || 'local';
  const { data: dataDirInfo } = useDataDirInfo(config.dataDir);
  const { provider, parts } = getConnectionInfo(
    backend,
    config,
    dataDirInfo,
    isHardcoded,
    backendDisplayName
  );
  const subString =
    backend === 'local'
      ? dataDirInfo?.shortName
      : backend === 'vercel'
        ? config.env
        : undefined;
  return (
    <div className="text-sm text-muted-foreground flex items-center gap-2">
      {isHardcoded && <Lock className="w-3 h-3" />}
      <span className="font-medium">
        Connected to: {provider} {subString ? `(${subString})` : ''}
      </span>
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
