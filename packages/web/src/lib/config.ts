'use client';

import type { EnvMap } from '@workflow/web-shared/server';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import type { WorldConfig } from '@/lib/config-world';

// Default configuration
const DEFAULT_CONFIG: WorldConfig = {
  backend: 'embedded',
  dataDir: '../../workbench/nextjs-turbopack/.next/workflow-data',
  port: '3000',
  env: 'production',
};

// Config query param keys
const CONFIG_PARAM_KEYS = [
  'backend',
  'env',
  'authToken',
  'project',
  'team',
  'port',
  'dataDir',
] as const;

/**
 * Hook that reads query params and returns the current config
 * Config is derived from default config + query params
 */
export function useQueryParamConfig(): WorldConfig {
  const searchParams = useSearchParams();

  const config = useMemo(() => {
    const configFromParams: WorldConfig = { ...DEFAULT_CONFIG };

    // Override with query parameters
    for (const key of CONFIG_PARAM_KEYS) {
      const value = searchParams.get(key);
      if (value) {
        configFromParams[key] = value;
      }
    }

    return configFromParams;
  }, [searchParams]);

  return config;
}

/**
 * Hook that returns a function to update config query params
 * Preserves all other query params while updating config params
 */
export function useUpdateConfigQueryParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const updateConfig = useMemo(
    () => (newConfig: WorldConfig) => {
      const params = new URLSearchParams(searchParams.toString());

      // Update config params
      for (const key of CONFIG_PARAM_KEYS) {
        const value = newConfig[key];
        if (value !== undefined && value !== null && value !== '') {
          // Only set if it differs from default or if it was already set
          if (value !== DEFAULT_CONFIG[key] || searchParams.has(key)) {
            params.set(key, value);
          }
        } else {
          // Remove param if it's undefined/null/empty
          params.delete(key);
        }
      }

      // Navigate with updated params
      const queryString = params.toString();
      const newUrl = queryString ? `${pathname}?${queryString}` : pathname;
      router.push(newUrl);
    },
    [router, pathname, searchParams]
  );

  return updateConfig;
}

/**
 * Helper to get config params from a URLSearchParams object
 * Useful for building URLs with config params
 */
export function getConfigParams(config: WorldConfig): URLSearchParams {
  const params = new URLSearchParams();

  for (const key of CONFIG_PARAM_KEYS) {
    const value = config[key];
    if (
      value !== undefined &&
      value !== null &&
      value !== '' &&
      value !== DEFAULT_CONFIG[key]
    ) {
      params.set(key, value);
    }
  }

  return params;
}

/**
 * Helper to build a URL with config params while preserving other params
 */
export function buildUrlWithConfig(
  path: string,
  config: WorldConfig,
  additionalParams?: Record<string, string>
): string {
  const params = getConfigParams(config);

  // Add additional params
  if (additionalParams) {
    for (const [key, value] of Object.entries(additionalParams)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, value);
      }
    }
  }

  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export const worldConfigToEnvMap = (config: WorldConfig): EnvMap => {
  return {
    WORKFLOW_TARGET_WORLD: config.backend,
    WORKFLOW_VERCEL_ENV: config.env,
    WORKFLOW_VERCEL_AUTH_TOKEN: config.authToken,
    WORKFLOW_VERCEL_PROJECT: config.project,
    WORKFLOW_VERCEL_TEAM: config.team,
    PORT: config.port,
    WORKFLOW_EMBEDDED_DATA_DIR: config.dataDir,
  };
};
