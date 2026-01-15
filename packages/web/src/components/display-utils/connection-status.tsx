'use client';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useServerConfig } from '@/lib/world-config-context';

type ServerConfigValue = ReturnType<typeof useServerConfig>['serverConfig'];

function getLocalShortName(displayInfo: ServerConfigValue['displayInfo']) {
  return displayInfo?.['local.shortName'];
}

function _getLocalDataDirPath(displayInfo: ServerConfigValue['displayInfo']) {
  return displayInfo?.['local.dataDirPath'];
}

function getShowLocalMisconfigWarning(
  backendId: string,
  displayInfo: ServerConfigValue['displayInfo']
): boolean {
  return (
    (backendId === 'local' || backendId === '@workflow/world-local') &&
    getLocalShortName(displayInfo) === 'packages/web'
  );
}

function getVercelDisplayString(
  publicEnv: ServerConfigValue['publicEnv']
): string {
  const env = publicEnv.WORKFLOW_VERCEL_ENV || 'production';
  const team = publicEnv.WORKFLOW_VERCEL_TEAM;
  const project = publicEnv.WORKFLOW_VERCEL_PROJECT;
  const vercelInfo =
    team && project ? `${team}/${project}` : project || team || 'Unknown';
  return `Connected to Vercel ${env} (${vercelInfo})`;
}

function getPostgresDisplayString(
  displayInfo: ServerConfigValue['displayInfo']
): string {
  const host = displayInfo?.['derived.WORKFLOW_POSTGRES_URL.hostname'];
  const db = displayInfo?.['derived.WORKFLOW_POSTGRES_URL.database'];
  if (!host) return 'Connected to Postgres';
  return `Connected to Postgres (${host}${db ? `/${db}` : ''})`;
}

function getDisplayString(config: ServerConfigValue): string {
  const { backendDisplayName, backendId, displayInfo, publicEnv } = config;
  switch (backendId) {
    case 'local':
    case '@workflow/world-local':
      return `Local Dev: ${getLocalShortName(displayInfo) || 'Unknown'}`;
    case 'vercel':
    case '@workflow/world-vercel':
      return getVercelDisplayString(publicEnv);
    case 'postgres':
    case '@workflow/world-postgres':
      return getPostgresDisplayString(displayInfo);
    default:
      return `Connected to: ${backendDisplayName}`;
  }
}

function renderKeyValueTable(rows: Array<{ key: string; value: string }>) {
  return (
    <div className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
      {rows.map(({ key, value }) => (
        <div key={key} className="contents">
          <div className="font-mono text-xs text-muted-foreground">{key}</div>
          <div className="font-mono text-xs text-foreground break-all">
            {value}
          </div>
        </div>
      ))}
    </div>
  );
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
  const { backendId } = serverConfig;
  const showLocalMisconfigWarning = getShowLocalMisconfigWarning(
    backendId,
    serverConfig.displayInfo
  );

  const publicEnvEntries = Object.entries(serverConfig.publicEnv).sort(
    ([a], [b]) => a.localeCompare(b)
  );
  const sensitiveKeys = [...serverConfig.sensitiveEnvKeys].sort();

  const hasTooltip =
    publicEnvEntries.length > 0 ||
    sensitiveKeys.length > 0 ||
    showLocalMisconfigWarning;

  const content = (
    <div className="text-md whitespace-nowrap">
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
        <div className="flex flex-col gap-2 max-w-[640px]">
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

          {renderKeyValueTable([
            ...publicEnvEntries.map(([key, value]) => ({ key, value })),
            ...sensitiveKeys.map((key) => ({ key, value: '*****' })),
          ])}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
