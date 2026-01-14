'use client';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useServerConfig } from '@/lib/world-config-context';

type ServerConfigValue = ReturnType<typeof useServerConfig>['serverConfig'];

function getVercelTooltipParts(
  backendId: string,
  publicEnv: ServerConfigValue['publicEnv']
): string[] {
  if (backendId !== 'vercel' && backendId !== '@workflow/world-vercel')
    return [];
  if (publicEnv.kind !== 'vercel') return [];
  return [
    ...(publicEnv.environment ? [`environment: ${publicEnv.environment}`] : []),
    ...(publicEnv.projectId ? [`project: ${publicEnv.projectId}`] : []),
    ...(publicEnv.teamId ? [`team: ${publicEnv.teamId}`] : []),
  ];
}

function getLocalTooltipParts(
  backendId: string,
  publicEnv: ServerConfigValue['publicEnv']
): string[] {
  if (backendId !== 'local' && backendId !== '@workflow/world-local') return [];
  if (publicEnv.kind !== 'local') return [];
  return [
    ...(publicEnv.port ? [`port: ${publicEnv.port}`] : []),
    ...(publicEnv.dataDirPath ? [`dataDir: ${publicEnv.dataDirPath}`] : []),
    `projectDir: ${publicEnv.projectDir}`,
  ];
}

function getShowLocalMisconfigWarning(
  backendId: string,
  publicEnv: ServerConfigValue['publicEnv']
): boolean {
  return (
    (backendId === 'local' || backendId === '@workflow/world-local') &&
    publicEnv.kind === 'local' &&
    publicEnv.shortName === 'packages/web'
  );
}

function getBasicTooltipParts(
  backendId: string,
  publicEnv: ServerConfigValue['publicEnv']
): string[] {
  return [
    ...getVercelTooltipParts(backendId, publicEnv),
    ...getLocalTooltipParts(backendId, publicEnv),
  ];
}

function getDbTooltipParts(
  publicDbUris: ServerConfigValue['publicDbUris']
): string[] {
  return (
    publicDbUris?.map((info) => {
      const dbSuffix = info.database ? `/${info.database}` : '';
      return `${info.key}: ${info.protocol}://${info.hostname}${dbSuffix}`;
    }) ?? []
  );
}

function getLocalDisplayString(
  publicEnv: ServerConfigValue['publicEnv']
): string {
  const localLabel =
    publicEnv.kind === 'local' ? publicEnv.shortName : 'Unknown';
  return `Local Dev: ${localLabel}`;
}

function getVercelDisplayString(
  publicEnv: ServerConfigValue['publicEnv']
): string {
  if (publicEnv.kind !== 'vercel') {
    return 'Connected to Vercel (Unknown)';
  }

  let vercelInfo: string;
  if (publicEnv.teamId && publicEnv.projectId) {
    vercelInfo = `${publicEnv.teamId}/${publicEnv.projectId}`;
  } else {
    vercelInfo =
      publicEnv.projectId ||
      publicEnv.teamId ||
      publicEnv.environment ||
      'Unknown';
  }

  return `Connected to Vercel (${vercelInfo})`;
}

function getPostgresDisplayString(
  publicDbUris: ServerConfigValue['publicDbUris']
): string {
  const postgresInfo = publicDbUris?.find(
    (x) => x.key === 'WORKFLOW_POSTGRES_URL'
  );
  if (!postgresInfo?.hostname) return 'Connected to Postgres';
  const suffix = postgresInfo.database ? `/${postgresInfo.database}` : '';
  return `Connected to Postgres (${postgresInfo.hostname}${suffix})`;
}

function getDisplayString(config: ServerConfigValue): string {
  const { backendDisplayName, backendId, publicDbUris, publicEnv } = config;
  switch (backendId) {
    case 'local':
    case '@workflow/world-local':
      return getLocalDisplayString(publicEnv);
    case 'vercel':
    case '@workflow/world-vercel':
      return getVercelDisplayString(publicEnv);
    case 'postgres':
    case '@workflow/world-postgres':
      return getPostgresDisplayString(publicDbUris);
    default:
      return `Connected to: ${backendDisplayName}`;
  }
}

/**
 * Displays the current world connection status.
 *
 * This component shows information from the public server configuration.
 * Env-derived values are strictly allowlisted per world backend.
 */
export function ConnectionStatus() {
  const { serverConfig } = useServerConfig();
  const displayString = getDisplayString(serverConfig);
  const { backendId, publicEnv } = serverConfig;
  const showLocalMisconfigWarning = getShowLocalMisconfigWarning(
    backendId,
    publicEnv
  );
  const parts = getBasicTooltipParts(backendId, publicEnv);
  const dbParts = getDbTooltipParts(serverConfig.publicDbUris);

  const hasTooltip =
    parts.length > 0 || dbParts.length > 0 || showLocalMisconfigWarning;

  const content = (
    <div className="h-10 px-3 rounded-md border bg-background text-sm flex items-center">
      <span className="font-medium">{displayString}</span>
    </div>
  );

  // TODO: Based on queue or HTTP health check, show a live status icon.

  if (!hasTooltip) {
    return content;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
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
          {[...parts, ...dbParts].map((part) => (
            <span key={part}>{part}</span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
