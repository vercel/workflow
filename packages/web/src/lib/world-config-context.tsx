'use client';

import type { EnvMap, HardcodedConfig } from '@workflow/web-shared/server';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { WorldConfig } from './config-world';
import { useQueryParamConfig, worldConfigToEnvMap } from './config';

// Re-export HardcodedConfig for convenience
export type { HardcodedConfig } from '@workflow/web-shared/server';

export interface WorldConfigContextValue {
  /** The current world configuration */
  config: WorldConfig;
  /** The environment map derived from the config */
  envMap: EnvMap;
  /** Whether the config is hardcoded (self-hosted mode) */
  isHardcoded: boolean;
  /** Human-readable name of the backend (only set in hardcoded mode) */
  backendDisplayName?: string;
  /** Whether the config is still loading */
  isLoading: boolean;
}

const WorldConfigContext = createContext<WorldConfigContextValue | null>(null);

interface WorldConfigProviderProps {
  children: ReactNode;
  /** Initial hardcoded config from server (if any) */
  hardcodedConfig?: HardcodedConfig;
}

/**
 * Converts an EnvMap back to a WorldConfig for display purposes.
 * This is the inverse of worldConfigToEnvMap.
 */
function envMapToWorldConfig(envMap: EnvMap): WorldConfig {
  const targetWorld = envMap.WORKFLOW_TARGET_WORLD;
  let backend: string | undefined;

  // Map target world back to backend ID
  if (targetWorld === '@workflow/world-postgres') {
    backend = 'postgres';
  } else if (targetWorld === 'vercel' || targetWorld === 'local') {
    backend = targetWorld;
  } else {
    backend = targetWorld;
  }

  return {
    backend,
    env: envMap.WORKFLOW_VERCEL_ENV,
    authToken: envMap.WORKFLOW_VERCEL_AUTH_TOKEN,
    project: envMap.WORKFLOW_VERCEL_PROJECT,
    team: envMap.WORKFLOW_VERCEL_TEAM,
    port: envMap.PORT,
    manifestPath: envMap.WORKFLOW_MANIFEST_PATH,
    dataDir: envMap.WORKFLOW_LOCAL_DATA_DIR || './',
    postgresUrl: envMap.WORKFLOW_POSTGRES_URL,
  };
}

export function WorldConfigProvider({
  children,
  hardcodedConfig,
}: WorldConfigProviderProps) {
  const queryParamConfig = useQueryParamConfig();
  const [isLoading, setIsLoading] = useState(!hardcodedConfig);

  useEffect(() => {
    // Once we have hardcodedConfig (or know we're in dynamic mode), stop loading
    if (hardcodedConfig !== undefined) {
      setIsLoading(false);
    }
  }, [hardcodedConfig]);

  // Determine which config to use
  const isHardcoded = hardcodedConfig?.isHardcoded ?? false;

  // In hardcoded mode, derive config from the server's envMap
  // In dynamic mode, use query params
  const config =
    isHardcoded && hardcodedConfig?.envMap
      ? envMapToWorldConfig(hardcodedConfig.envMap)
      : queryParamConfig;

  // In hardcoded mode, use the server's envMap directly
  // In dynamic mode, convert the query param config to envMap
  const envMap =
    isHardcoded && hardcodedConfig?.envMap
      ? hardcodedConfig.envMap
      : worldConfigToEnvMap(config);

  const value: WorldConfigContextValue = {
    config,
    envMap,
    isHardcoded,
    backendDisplayName: hardcodedConfig?.backendDisplayName,
    isLoading,
  };

  return (
    <WorldConfigContext.Provider value={value}>
      {children}
    </WorldConfigContext.Provider>
  );
}

/**
 * Hook to access the world configuration context.
 * Returns the current config, envMap, and whether it's hardcoded.
 */
export function useWorldConfig(): WorldConfigContextValue {
  const context = useContext(WorldConfigContext);
  if (!context) {
    throw new Error('useWorldConfig must be used within a WorldConfigProvider');
  }
  return context;
}
