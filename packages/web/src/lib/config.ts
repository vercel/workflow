'use client';

import type { EnvMap } from '@workflow/web-shared/server';
import { createSerializer, parseAsString, useQueryStates } from 'nuqs';
import type { WorldConfig } from '@/lib/config-world';

// Default configuration
// Note: dataDir is intentionally undefined - the server will auto-discover
// the workflow data directory from the current working directory using
// findWorkflowDataDir() from @workflow/utils/check-data-dir
const DEFAULT_CONFIG: Partial<WorldConfig> = {
  backend: 'local',
  port: '3000',
  env: 'production',
};

// nuqs parsers for config params
const configParsers = {
  backend: parseAsString.withDefault(DEFAULT_CONFIG.backend || 'local'),
  env: parseAsString.withDefault(DEFAULT_CONFIG.env || 'production'),
  authToken: parseAsString,
  project: parseAsString,
  team: parseAsString,
  port: parseAsString.withDefault(DEFAULT_CONFIG.port || '3000'),
  dataDir: parseAsString.withDefault('./'),
  manifestPath: parseAsString,
};

// Create a serializer for config params
const serializeConfig = createSerializer(configParsers);
export const resolveTargetWorld = (backend?: string) => {
  switch (backend) {
    case 'postgres':
      return '@workflow/world-postgres';
    default:
      return backend;
  }
};

/**
 * Hook that reads query params and returns the current config
 * Uses nuqs for type-safe URL state management
 * Config is derived from default config + query params
 */
export function useQueryParamConfig(): WorldConfig {
  const [config] = useQueryStates(configParsers, {
    history: 'push',
    shallow: true,
  });

  return config as WorldConfig;
}

/**
 * Hook that returns a function to update config query params
 * Uses nuqs for type-safe URL state management
 * Preserves all other query params while updating config params
 */
export function useUpdateConfigQueryParams() {
  const [, setConfig] = useQueryStates(configParsers, {
    history: 'push',
    shallow: true,
  });

  return (newConfig: WorldConfig) => {
    // Filter out null/undefined values and only set non-default values
    const filtered: Record<string, string | null> = {};

    for (const [key, value] of Object.entries(newConfig)) {
      if (value === undefined || value === null || value === '') {
        filtered[key] = null; // nuqs uses null to clear params
      } else if (value !== DEFAULT_CONFIG[key as keyof WorldConfig]) {
        filtered[key] = value;
      } else {
        filtered[key] = null;
      }
    }

    setConfig(filtered);
  };
}

/**
 * Helper to build a URL with config params while preserving other params
 * Uses nuqs serializer for type-safe URL construction
 */
export function buildUrlWithConfig(
  path: string,
  config: WorldConfig,
  additionalParams?: Record<string, string>
): string {
  // Serialize config params using nuqs
  const queryString = serializeConfig(config);
  const params = new URLSearchParams(queryString);

  // Add additional params
  if (additionalParams) {
    for (const [key, value] of Object.entries(additionalParams)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, value);
      }
    }
  }

  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export const worldConfigToEnvMap = (config: WorldConfig): EnvMap => {
  return {
    WORKFLOW_TARGET_WORLD: resolveTargetWorld(config.backend),
    WORKFLOW_VERCEL_ENV: config.env,
    WORKFLOW_VERCEL_AUTH_TOKEN: config.authToken,
    WORKFLOW_VERCEL_PROJECT: config.project,
    WORKFLOW_VERCEL_TEAM: config.team,
    PORT: config.port,
    WORKFLOW_MANIFEST_PATH: config.manifestPath,
    WORKFLOW_LOCAL_DATA_DIR: config.dataDir,
    // Postgres env vars
    WORKFLOW_POSTGRES_URL: config.postgresUrl,
  };
};
