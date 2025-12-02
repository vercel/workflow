import { getPort } from '@workflow/utils/get-port';
import { once } from './util.js';

const getDataDirFromEnv = () => {
  return process.env.WORKFLOW_LOCAL_DATA_DIR || '.workflow-data';
};

export const DEFAULT_RESOLVE_DATA_OPTION = 'all';

const getBaseUrlFromEnv = () => {
  return process.env.WORKFLOW_LOCAL_BASE_URL;
};

export type Config = {
  dataDir: string;
  port?: number;
  baseUrl?: string;
};

export const config = once<Config>(() => {
  const dataDir = getDataDirFromEnv();
  const baseUrl = getBaseUrlFromEnv();

  return { dataDir, baseUrl };
});

/**
 * Resolves the base URL for queue requests following the priority order:
 * 1. config.baseUrl (highest priority - full override from args or WORKFLOW_LOCAL_BASE_URL env var)
 * 2. config.port (explicit port override from args)
 * 3. PORT env var (explicit configuration)
 * 4. Auto-detected port via getPort (detect actual listening port)
 */
export async function resolveBaseUrl(config: Partial<Config>): Promise<string> {
  if (config.baseUrl) {
    return config.baseUrl;
  }

  if (typeof config.port === 'number') {
    return `http://localhost:${config.port}`;
  }

  if (process.env.PORT) {
    return `http://localhost:${process.env.PORT}`;
  }

  const detectedPort = await getPort();
  if (detectedPort) {
    return `http://localhost:${detectedPort}`;
  }

  throw new Error('Unable to resolve base URL for workflow queue.');
}
